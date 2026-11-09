import type { ExchangeId, Kline, MarketType, Timeframe } from '../types';
import { fetchDirectKlines } from './directExchangeClient';

/**
 * Per-tab coalescing for remote analysis candles: multiple HookCharts can show
 * the same coin/timeframe without each creating an identical exchange request.
 * Failed requests are never cached; the cache contains no user data.
 */
export function createTimedRequestCache<T>(ttlMs: number, limit = 128, now = () => Date.now()) {
  const entries = new Map<string, { expires: number; task: Promise<T> }>();
  return {
    load(key: string, loader: () => Promise<T>): Promise<T> {
      const cached = entries.get(key);
      if (cached && cached.expires > now()) return cached.task;
      if (cached) entries.delete(key);

      const task = Promise.resolve().then(loader);
      entries.set(key, { expires: now() + ttlMs, task });
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
      void task.catch(() => {
        if (entries.get(key)?.task === task) entries.delete(key);
      });
      return task;
    },
    clear(): void { entries.clear(); },
    get size(): number { return entries.size; },
  };
}

// Keep multi-chart memory usage bounded on mobile (up to 48 unique series).
const analysisCache = createTimedRequestCache<Kline[]>(45_000, 48);

export function fetchSharedAnalysisKlines(
  exchange: ExchangeId,
  marketType: MarketType,
  symbol: string,
  timeframe: Timeframe,
  limit: number,
): Promise<Kline[]> {
  const key = [exchange, marketType, symbol.toUpperCase(), timeframe, limit].join(':');
  return analysisCache.load(key, () => fetchDirectKlines(exchange, marketType, symbol, timeframe, limit));
}
