import type { ExchangeId, Kline, MarketType } from '../../types';
import { normalizeExchangeSymbol } from '../../utils/marketSymbols';
import { validCandle } from '../../utils/hookchartData';
import { createTimedRequestCache } from '../../utils/sharedAnalysisKlines';

/** Short request coalescing is only for reconnect fallback, never for replay history. */
const fallback = createTimedRequestCache<Kline | null>(1800, 96);

export function fetchSharedLiveFallbackKline(
  exchange: ExchangeId, marketType: MarketType, symbol: string, timeframe: string,
): Promise<Kline | null> {
  const normalized = normalizeExchangeSymbol(symbol);
  const key = [exchange, marketType, normalized, timeframe].join(':');
  return fallback.load(key, async () => {
    const params = new URLSearchParams({
      exchange, market: marketType, symbol: normalized, timeframe, limit: '3',
    });
    const response = await fetch('/api/klines?' + params);
    if (!response.ok) throw new Error('Live fallback HTTP ' + response.status);
    const json = await response.json();
    if (!json?.success || !Array.isArray(json.data)) return null;
    for (let i = json.data.length - 1; i >= 0; i--) {
      const row = json.data[i] as Kline;
      if (validCandle(row)) return row;
    }
    return null;
  });
}
