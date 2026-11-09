import { exchangeFetch } from './exchangeHttp';
import type { ExchangeId, MarketType } from '../src/types';

export interface RawTicker {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  exchange: ExchangeId;
  marketType: MarketType;
  price: number;
  change24h: number;
  volumeUsd: number;
  high24h: number;
  low24h: number;
}

export interface MarketSourceStatus {
  exchange: ExchangeId;
  marketType: MarketType;
  status: 'live' | 'stale' | 'unavailable';
  updatedAt: number | null;
  error?: string;
  httpStatus?: number;
}

interface FeedEntry {
  data: RawTicker[];
  updatedAt: number | null;
  retryAt: number;
  error?: string;
  httpStatus?: number;
  pending?: Promise<RawTicker[]>;
  snapshotAt?: number;
  streamAt?: number;
  /** WS changes arriving after the current REST reconciliation started. */
  inFlightWsUpdates?: Map<string, RawTicker>;
  restSuccesses?: number;
  restFailures?: number;
  lastRestFailureAt?: number;
  lastRestFailure?: string;
  lastRestSuccessAt?: number;
}

const FRESH_MS = 15_000;
const STALE_MS = 120_000;

/** Shares requests across screener, sentiment and formation scans. */
export class MarketTickerFeed {
  private entries = new Map<string, FeedEntry>();

  /** Preserve original collection times without performing any network work. */
  cached() {
    return Array.from(this.entries.entries()).map(([key, entry]) => ({
      key, data: entry.data, updatedAt: entry.updatedAt,
    }));
  }

  constructor(
    private request: typeof fetch = (input, init) => exchangeFetch(input, init),
    private now: () => number = Date.now,
  ) {}

  private entry(exchange: ExchangeId, market: MarketType): FeedEntry {
    const key = `${exchange}:${market}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { data: [], updatedAt: null, retryAt: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  status(exchange: ExchangeId, market: MarketType): MarketSourceStatus {
    const entry = this.entry(exchange, market);
    const now = this.now();
    const age = entry.updatedAt === null ? Infinity : now - entry.updatedAt;
    // A failed once-per-minute REST reconciliation must not mark the screener
    // stale while validated live miniTicker frames are still arriving.
    const wsFresh = entry.streamAt !== undefined && now - entry.streamAt >= 0 && now - entry.streamAt < FRESH_MS;
    const effectiveError = wsFresh ? undefined : entry.error;
    return {
      exchange, marketType: market,
      status: age < FRESH_MS && !effectiveError ? 'live' : age < STALE_MS ? 'stale' : 'unavailable',
      updatedAt: entry.updatedAt,
      ...(effectiveError ? { error: effectiveError } : {}),
      ...(effectiveError && entry.httpStatus ? { httpStatus: entry.httpStatus } : {}),
    };
  }

  diagnostics() {
    const now = this.now();
    return Array.from(this.entries.entries(), ([source, entry]) => ({
      source, status: this.status(source.split(':')[0] as ExchangeId, source.split(':')[1] as MarketType).status,
      quoteAgeMs: entry.updatedAt === null ? null : now - entry.updatedAt,
      wsAgeMs: entry.streamAt === undefined ? null : now - entry.streamAt,
      restSuccesses: entry.restSuccesses ?? 0, restFailures: entry.restFailures ?? 0,
      lastRestSuccessAt: entry.lastRestSuccessAt ?? null,
      lastRestFailureAt: entry.lastRestFailureAt ?? null,
      lastRestFailure: entry.lastRestFailure ?? null,
      lastHttpStatus: entry.httpStatus ?? null,
    }));
  }

  async get(exchange: ExchangeId, market: MarketType): Promise<RawTicker[]> {
    const entry = this.entry(exchange, market);
    const now = this.now();
    const fresh = this.status(exchange, market).status === 'live';
    const streamAlive = entry.streamAt !== undefined && now - entry.streamAt < 15_000;
    // Full-market REST snapshots reconcile symbols once per minute, but must
    // not block *any* browser while the WS is already delivering fresh data.
    const needReconcile = streamAlive && (!entry.snapshotAt || now - entry.snapshotAt >= 60_000);
    if (fresh && streamAlive) {
      if (needReconcile && !entry.pending && now >= entry.retryAt) {
        const background = this.load(exchange, market, entry);
        entry.pending = background;
        background.then(() => { if (entry.pending === background) entry.pending = undefined; },
          () => { if (entry.pending === background) entry.pending = undefined; });
      }
      return entry.data;
    }
    if (entry.pending) return entry.pending;
    if (fresh) return entry.data;
    if (now < entry.retryAt) {
      return this.status(exchange, market).status === 'unavailable' ? [] : entry.data;
    }
    entry.pending = this.load(exchange, market, entry);
    try { return await entry.pending; } finally { entry.pending = undefined; }
  }

  /**
   * Merge verified Binance mini-ticker WS values into the current REST
   * universe. Never invent new symbols from an incomplete WS change batch.
   * Full REST refreshes still discover listings and reconcile every minute.
   */
  applyBinanceMiniTickers(market: MarketType, ticks: unknown[]): number {
    const entry = this.entry('binance', market);
    if (!entry.data.length || !ticks.length) return 0;
    const bySymbol = new Map(entry.data.map(t => [t.symbol, t]));
    let changed = 0;
    for (const raw of ticks) {
      if (!raw || typeof raw !== 'object') continue;
      const tick = raw as Record<string, unknown>;
      const symbol = tick.s;
      // Binance Futures all-market streams can include COIN-M contracts after
      // market-stream unification. The screener is USD-M only (st=1).
      if (market === 'futures' && tick.st !== undefined && Number(tick.st) !== 1) continue;
      // If the event was delayed by socket congestion, do not stamp it as fresh.
      if (tick.E !== undefined) {
        const eventAt = Number(tick.E);
        if (!Number.isSafeInteger(eventAt) || eventAt > this.now() + 2_000 ||
            eventAt <= 0 || this.now() - eventAt > 15_000) continue;
      }
      if (typeof symbol !== 'string' || !bySymbol.has(symbol)) continue;
      const price = Number(tick.c), open = Number(tick.o);
      const high = Number(tick.h), low = Number(tick.l), volume = Number(tick.q);
      if (![price, open, high, low, volume].every(Number.isFinite) ||
          price <= 0 || open <= 0 || high < low || volume < 0) continue;
      const old = bySymbol.get(symbol)!;
      const update = { ...old, price, high24h: high, low24h: low,
        volumeUsd: volume, change24h: (price - open) / open * 100 };
      bySymbol.set(symbol, update);
      // A slow REST snapshot must never overwrite a later live WS tick.
      entry.inFlightWsUpdates?.set(symbol, update);
      changed++;
    }
    if (changed) {
      entry.data = [...bySymbol.values()].sort((a, b) => b.volumeUsd - a.volumeUsd);
      entry.streamAt = this.now();
      entry.updatedAt = this.now();
      entry.error = undefined;
      entry.httpStatus = undefined;
    }
    return changed;
  }

  private async load(exchange: ExchangeId, market: MarketType, entry: FeedEntry): Promise<RawTicker[]> {
    const urls = exchange === 'binance'
      ? market === 'spot'
        ? ['https://data-api.binance.vision/api/v3/ticker/24hr', 'https://api.binance.com/api/v3/ticker/24hr']
        : ['https://fapi.binance.com/fapi/v1/ticker/24hr']
      : ['https://api.bybit.com', 'https://api.bytick.com']
        .map(host => `${host}/v5/market/tickers?category=${market === 'spot' ? 'spot' : 'linear'}`);
    // Track only WS updates received while this REST request is pending.
    // This is bounded by the existing known-symbol universe.
    const overlay = exchange === 'binance' ? new Map<string, RawTicker>() : null;
    if (overlay) entry.inFlightWsUpdates = overlay;
    let error = 'Біржа не відповідає або повернула некоректні дані';
    let httpStatus: number | undefined;
    let retryMs = 15_000;
    let failureDetail = 'No valid response';
    for (const url of urls) {
      try {
        const response = await this.request(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'SignalHook/1.0' },
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) {
          httpStatus = response.status;
          failureDetail = `HTTP ${response.status} from ${new URL(url).hostname}`;
          error = response.status === 403 || response.status === 451
            ? `Біржа обмежила доступ із регіону сервера (HTTP ${response.status})`
            : response.status === 429
              ? 'Перевищено ліміт запитів біржі (HTTP 429)'
              : `Помилка біржі (HTTP ${response.status})`;
          // Do not retry denied or rate-limited requests through another hostname.
          if ([403, 451, 429].includes(response.status)) {
            const retryAfter = response.headers.get('retry-after');
            const seconds = retryAfter === null ? NaN : Number(retryAfter);
            const retryDate = retryAfter ? Date.parse(retryAfter) : NaN;
            retryMs = response.status === 403 && exchange === 'bybit' ? 600_000 : 60_000;
            if (Number.isFinite(seconds) && seconds >= 0) retryMs = Math.max(retryMs, seconds * 1000);
            else if (Number.isFinite(retryDate)) retryMs = Math.max(retryMs, retryDate - this.now());
            break;
          }
          continue;
        }
        const json = await response.json();
        if (exchange === 'bybit' && json?.retCode !== 0) {
          error = `Помилка API Bybit (код ${json?.retCode ?? 'невідомий'})`;
          if (json?.retCode === 10006) { retryMs = 60_000; break; }
          continue;
        }
        const list = exchange === 'binance' ? json : json?.result?.list;
        if (!Array.isArray(list) || list.length === 0) {
          failureDetail = `Invalid or empty ticker array from ${new URL(url).hostname}`;
          continue;
        }
        let data = list.filter(item => typeof item?.symbol === 'string' && item.symbol.endsWith('USDT'))
          .map((item): RawTicker => ({
            symbol: item.symbol, baseAsset: item.symbol.slice(0, -4), quoteAsset: 'USDT', exchange, marketType: market,
            price: Number(item.lastPrice),
            change24h: exchange === 'binance' ? Number(item.priceChangePercent) : Number(item.price24hPcnt) * 100,
            volumeUsd: Number(exchange === 'binance' ? item.quoteVolume : item.turnover24h),
            high24h: Number(exchange === 'binance' ? item.highPrice : item.highPrice24h),
            low24h: Number(exchange === 'binance' ? item.lowPrice : item.lowPrice24h),
          }))
          .filter(t => Number.isFinite(t.price) && t.price > 0 && Number.isFinite(t.volumeUsd) && t.volumeUsd >= 0
            && Number.isFinite(t.change24h) && Number.isFinite(t.high24h) && Number.isFinite(t.low24h))
          .sort((a, b) => b.volumeUsd - a.volumeUsd);
        if (overlay?.size) {
          const latest = new Map(data.map(t => [t.symbol, t]));
          for (const [symbol, tick] of overlay) {
            if (latest.has(symbol)) latest.set(symbol, tick);
          }
          data = [...latest.values()].sort((a, b) => b.volumeUsd - a.volumeUsd);
        }
        if (entry.inFlightWsUpdates === overlay) entry.inFlightWsUpdates = undefined;
        entry.data = data;
        entry.snapshotAt = this.now();
        entry.updatedAt = this.now();
        entry.restSuccesses = (entry.restSuccesses ?? 0) + 1;
        entry.lastRestSuccessAt = this.now();
        entry.retryAt = 0;
        entry.error = undefined;
        entry.httpStatus = undefined;
        return data;
      } catch (cause) {
        // Keep the precise transport cause in operator metrics / VPS logs.
        // Never expose backend addresses, credentials or request headers.
        const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        failureDetail = `${new URL(url).hostname}: ${reason}`.slice(0, 240);
      }
    }
    if (entry.inFlightWsUpdates === overlay) entry.inFlightWsUpdates = undefined;
    const lastLogged = entry.lastRestFailureAt ?? 0;
    entry.restFailures = (entry.restFailures ?? 0) + 1;
    entry.lastRestFailureAt = this.now();
    entry.lastRestFailure = failureDetail;
    if (this.now() - lastLogged > 60_000) {
      console.warn(`[MarketTickerFeed] ${exchange}:${market} REST reconciliation failed: ${error}; ${failureDetail}`);
    }
    entry.error = error;
    entry.httpStatus = httpStatus;
    entry.retryAt = this.now() + retryMs;
    return this.status(exchange, market).status === 'unavailable' ? [] : entry.data;
  }
}

export const marketTickerFeed = new MarketTickerFeed();

export function getMarketSourceStatuses(params: {
  exchange?: 'all' | ExchangeId;
  marketType?: 'all' | MarketType;
}): MarketSourceStatus[] {
  const exchanges: ExchangeId[] = params.exchange && params.exchange !== 'all' ? [params.exchange] : ['binance', 'bybit'];
  const markets: MarketType[] = params.marketType && params.marketType !== 'all' ? [params.marketType] : ['futures', 'spot'];
  return exchanges.flatMap(exchange => markets.map(market => marketTickerFeed.status(exchange, market)));
}
