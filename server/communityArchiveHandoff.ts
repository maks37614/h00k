import { AuthFailure } from "./pgIdentity";
import type { Kline } from "../src/types";
import type { SignedArchivedScore } from "./archiveQualityProof";

type Scope = {
  symbol: string;
  exchange: "binance" | "bybit";
  marketType: "spot" | "futures";
  timeframe: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
};
export type CommunityArchiveHandoff = Scope & {
  version: 1;
  source: "h00k.top";
  issuedAt: number;
  expiresAt: number;
  capturedAt: number;
  candles: [number, number, number, number, number, number][];
  markers: Array<{ type: "entry" | "stop_loss" | "target" | "neckline"; price: number }>;
  qualityProof?: SignedArchivedScore;
};
export const HANDOFF_TF_SECONDS: Record<Scope["timeframe"],number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
};
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

function scopeFor(archive: any): Scope {
  if (!archive || typeof archive !== "object" ||
    typeof archive.symbol !== "string" || !/^[A-Z0-9]{2,30}$/.test(archive.symbol) ||
    !["binance","bybit"].includes(archive.exchange) ||
    !["spot","futures"].includes(archive.marketType) ||
    !Object.hasOwn(HANDOFF_TF_SECONDS, archive.timeframe))
    throw new AuthFailure(422, "Архів не містить коректного ринку для передачі.", "HANDOFF_SCOPE");
  return {
    symbol: archive.symbol, exchange: archive.exchange,
    marketType: archive.marketType, timeframe: archive.timeframe,
  };
}

export function handoffQuery(archive: any, now = Date.now()) {
  const scope = scopeFor(archive);
  const capturedAt = archive.savedAtTimestamp;
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 1 || capturedAt > now + 60_000)
    throw new AuthFailure(422, "Некоректний час збереженої формації.", "HANDOFF_TIME");
  const markers = [
    ["entry", archive.entryPrice],
    ["stop_loss", archive.stopLossPrice],
    ["target", archive.targetPrice],
    ...(positive(archive.necklinePrice) ? [["neckline", archive.necklinePrice]] : []),
  ] as Array<[CommunityArchiveHandoff["markers"][number]["type"], number]>;
  if (markers.some(([, price]) => !positive(price)))
    throw new AuthFailure(422, "В архіві немає повних рівнів Entry, SL і TP.", "HANDOFF_LEVELS");
  return {
    scope, capturedAt,
    endTime: Math.min(capturedAt, now), markers: markers.map(([type,price]) => ({type,price})),
  };
}

/**
 * Historical exchange candles are fetched once by the screener on an explicit
 * owner action. An incomplete candle cannot be put into an imported snapshot.
 * No private notes, account ID, password or API credential is ever exported.
 */
export function createCommunityHandoff(
  archive: any, fetched: readonly Kline[], now = Date.now(),
  qualityProof?: SignedArchivedScore,
): CommunityArchiveHandoff {
  const { scope, capturedAt, markers } = handoffQuery(archive, now);
  const step = HANDOFF_TF_SECONDS[scope.timeframe];
  const candles = [...fetched].filter(k =>
    Number.isSafeInteger(k.time) && k.time > 0 && k.time % step === 0 &&
    (k.time + step) * 1000 <= capturedAt &&
    [k.open,k.high,k.low,k.close,k.volume].every(n => typeof n === "number" && Number.isFinite(n)) &&
    k.low > 0 && k.open > 0 && k.close > 0 &&
    k.high >= Math.max(k.open,k.close,k.low) && k.low <= Math.min(k.open,k.close) &&
    k.volume >= 0,
  ).sort((a,b) => a.time-b.time).slice(-55);
  // A real exchange result is required. Never manufacture one from the archive price.
  if (candles.length < 10 || new Set(candles.map(k => k.time)).size !== candles.length)
    throw new AuthFailure(503, "Недостатньо історичних свічок для передачі графіка.", "HANDOFF_CANDLES");
  return {
    version: 1, source: "h00k.top", ...scope,
    capturedAt, issuedAt: now, expiresAt: now+10*60_000,
    candles: candles.map(k => [k.time,k.open,k.high,k.low,k.close,k.volume]),
    markers,
    ...(qualityProof ? { qualityProof } : {}),
  };
}

const ORIGINS = ["https://community-stage.h00k.top", "https://community.h00k.top"];

export function communityHandoffUrl(payload: CommunityArchiveHandoff, origin?: string): string {
  const target = origin || "https://community-stage.h00k.top";
  if (!ORIGINS.includes(target)) throw new AuthFailure(503, "Community origin не дозволений.", "HANDOFF_ORIGIN");
  // Only public market candles + selected author levels + optional signed
  // score record. The fragment is never sent as an HTTP request or referrer.
  const token = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  if (token.length > 24000) throw new AuthFailure(413, "Знімок завеликий для переходу.", "HANDOFF_TOO_LARGE");
  return target + "/#community?section=feed&handoff=" + token;
}
