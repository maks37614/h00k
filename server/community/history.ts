import type { Database } from "./db";
import type { ExchangeId, Kline, MarketType, Timeframe } from "../../src/types";
import {
  COMMUNITY_TIMEFRAMES,
  TF_SECONDS,
} from "../../src/community/chartDocument";
import { fail } from "./security";

export async function exchangeSlot(db: Database, scope: string) {
  if (process.env.COMMUNITY_EXCHANGE_EGRESS_ISOLATED !== "1")
    fail(
      "Біржовий шлюз Community ще не активовано: потрібен виділений вихід або координований бюджет.",
      503,
    );
  const delay = await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO hc_exchange_budget(scope,next_at) VALUES($1,now()) ON CONFLICT DO NOTHING",
      [scope],
    );
    const { rows } = await tx.query(
      "SELECT next_at FROM hc_exchange_budget WHERE scope=$1 FOR UPDATE",
      [scope],
    );
    const at = Math.max(Date.now(), new Date(rows[0].next_at).getTime());
    if (at - Date.now() > 5000)
      fail("Черга біржових запитів заповнена. Повторіть пізніше.", 429);
    await tx.query("UPDATE hc_exchange_budget SET next_at=$2 WHERE scope=$1", [
      scope,
      new Date(at + 500),
    ]);
    return Math.max(0, at - Date.now());
  });
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
}
const pending = new Map<string, Promise<Kline[]>>();

/** Aligned 500-bar blocks, durable shared cache, coalescing, no client fallback or timers. */
export async function historyBlock(
  db: Database,
  input: {
    symbol: string;
    exchange: ExchangeId;
    marketType: MarketType;
    timeframe: Timeframe;
    before: number;
  },
): Promise<Kline[]> {
  const { symbol, exchange, marketType, timeframe } = input;
  if (
    !/^[\p{L}\p{M}\p{N}]{2,30}$/u.test(symbol) ||
    !["bybit", "binance"].includes(exchange) ||
    !["spot", "futures"].includes(marketType) ||
    !COMMUNITY_TIMEFRAMES.includes(timeframe)
  )
    fail("Некоректний запит історії");
  if (
    !Number.isFinite(input.before) ||
    input.before < 1 ||
    input.before > Date.now() / 1000 + 60
  )
    fail("Некоректна дата історії");
  const step = TF_SECONDS[timeframe],
    blockSize = 500;
  const blockStart =
    Math.floor(input.before / (step * blockSize)) * step * blockSize;
  const end = Math.min(
    blockStart + step * blockSize - 1,
    Math.floor(Date.now() / 1000),
  );
  const key = [exchange, marketType, symbol, timeframe, blockStart].join(":");
  const cached = await db.query(
    "SELECT rows FROM hc_history WHERE key=$1 AND fresh_until>now()",
    [key],
  );
  if (cached.rows.length)
    return cached.rows[0].rows.filter((r: Kline) => r.time <= input.before);
  if (pending.has(key))
    return (await pending.get(key)!).filter((r) => r.time <= input.before);
  if (pending.size >= 2) fail("Історія тимчасово зайнята", 503);
  const task = (async () => {
    // A transaction-scoped lock also coalesces misses across service replicas.
    await exchangeSlot(db, exchange);
    return db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const other = await tx.query(
        "SELECT rows FROM hc_history WHERE key=$1 AND fresh_until>now()",
        [key],
      );
      if (other.rows.length) return other.rows[0].rows as Kline[];
      let url: string;
      if (exchange === "bybit") {
        const interval: Record<Timeframe, string> = {
          "1m": "1",
          "5m": "5",
          "15m": "15",
          "1h": "60",
          "4h": "240",
          "1d": "D",
        };
        url =
          "https://api.bybit.com/v5/market/kline?" +
          new URLSearchParams({
            category: marketType === "spot" ? "spot" : "linear",
            symbol,
            interval: interval[timeframe],
            start: String(blockStart * 1000),
            end: String(end * 1000),
            limit: "500",
          });
      } else
        url =
          `https://${marketType === "spot" ? "api.binance.com/api/v3" : "fapi.binance.com/fapi/v1"}/klines?` +
          new URLSearchParams({
            symbol,
            interval: timeframe,
            startTime: String(blockStart * 1000),
            endTime: String(end * 1000),
            limit: "500",
          });
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) fail("Біржа тимчасово не надала історію", 503);
      const data = await res.json();
      if (exchange === "bybit" && data.retCode !== 0)
        fail("Історія цього ринку недоступна", 503);
      const raw = exchange === "bybit" ? data.result?.list : data;
      if (!Array.isArray(raw)) fail("Некоректна відповідь історії", 503);
      const rows: Kline[] = raw.map((r: any) => ({
        time: Number(r[0]) / 1000,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      }));
      if (
        rows.some(
          (r) =>
            !Object.values(r).every(Number.isFinite) ||
            r.low <= 0 ||
            r.high < Math.max(r.open, r.close, r.low) ||
            r.low > Math.min(r.open, r.close) ||
            r.volume < 0,
        )
      )
        fail("Некоректні біржові свічки", 503);
      rows.sort((a, b) => a.time - b.time);
      // Fully closed historical blocks are immutable; the active block expires.
      const ttl =
        end < Math.floor(Date.now() / 1000) - step ? 365 * 86400_000 : 30_000;
      await tx.query(
        "INSERT INTO hc_history(key,rows,fresh_until) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET rows=excluded.rows,fresh_until=excluded.fresh_until",
        [key, JSON.stringify(rows), new Date(Date.now() + ttl)],
      );
      return rows;
    });
  })();
  pending.set(key, task);
  try {
    return (await task).filter((r) => r.time <= input.before);
  } finally {
    pending.delete(key);
  }
}
