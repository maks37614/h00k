import type { MarketCoin, MarketSentimentData } from '../src/types';
import { exchangeFetch } from './exchangeHttp';

/** No synthetic OI: Bybit's already-fetched linear USDT tickers expose USD OI and funding. */
export function aggregateBybitDerivatives(coins: readonly MarketCoin[]): MarketSentimentData['derivativesOverview'] {
  let openInterestUsd = 0;
  let fundingWeightedSum = 0;
  let fundingWeight = 0;
  let count = 0;
  for (const coin of coins) {
    if (coin.exchange !== 'bybit' || coin.marketType !== 'futures' ||
        !Number.isFinite(coin.openInterestUsd) || (coin.openInterestUsd ?? 0) <= 0) continue;
    const oi = coin.openInterestUsd!;
    openInterestUsd += oi;
    count++;
    if (Number.isFinite(coin.fundingRatePct)) {
      fundingWeightedSum += coin.fundingRatePct! * oi;
      fundingWeight += oi;
    }
  }
  const avgFundingRate = fundingWeight > 0 ? Number((fundingWeightedSum / fundingWeight).toFixed(5)) : null;
  return {
    aggregatedOIUsd: count > 0 ? Math.round(openInterestUsd) : null,
    oiChange24hPct: null, // A one-time ticker cannot establish a 24-hour OI change.
    avgFundingRate,
    fundingBias: avgFundingRate === null ? null : avgFundingRate > 0.01 ? 'long_heavy'
      : avgFundingRate < -0.01 ? 'short_heavy' : 'balanced',
    instrumentCount: count,
    sourceLabel: count > 0 ? `Bybit USDT Perpetual · ${count} контрактів` : undefined,
  };
}

export type TakerDeltaSnapshot = {
  deltaUsd: number;
  sampledPairs: number;
  requestedPairs: number;
  sampledAt: number;
};

/** One unfinished UTC-day candle; not a 24h rolling capital-inflow metric. */
export function parseBinanceDailyTakerDelta(payload: unknown, now: number): number | null {
  const row = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0] : null;
  if (!row || row.length < 11) return null;
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  if (Number(row[0]) !== day) return null;
  const quote = Number(row[7]);
  const buy = Number(row[10]);
  if (![quote, buy].every(Number.isFinite) || quote <= 0 || buy < 0 || buy > quote) return null;
  // taker buy quote volume - taker sell quote volume
  return 2 * buy - quote;
}

// At most eight lightweight Binance futures kline calls per five minutes,
// across ALL site visitors. Existing exchangeFetch enforces the shared IP budget.
const SAMPLE_SIZE = 8;
const CACHE_MS = 5 * 60_000;
let cache: { at: number; utcDay: number; value: TakerDeltaSnapshot | null } | null = null;
let inflight: Promise<TakerDeltaSnapshot | null> | null = null;

export async function getSampledTakerDelta(coins: readonly MarketCoin[], now = Date.now()):
  Promise<TakerDeltaSnapshot | null> {
  const utcDay = Math.floor(now / 86_400_000);
  if (cache && cache.utcDay === utcDay && now - cache.at >= 0 && now - cache.at < CACHE_MS) {
    return cache.value;
  }
  if (inflight) return inflight;

  const symbols = [...new Set(coins
    .filter(c => c.exchange === 'binance' && c.marketType === 'futures' && c.volumeUsd > 0 &&
      /^[A-Z0-9]{3,20}USDT$/.test(c.symbol))
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .map(c => c.symbol))].slice(0, SAMPLE_SIZE);
  if (!symbols.length) return null;

  inflight = (async () => {
    let current = 0;
    let delta = 0;
    let completed = 0;
    // Limit concurrent requests to four, even across many visitors.
    await Promise.all(Array.from({ length: Math.min(4, symbols.length) }, async () => {
      while (current < symbols.length) {
        const symbol = symbols[current++];
        try {
          const response = await exchangeFetch(
            `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=1`,
            { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2500) },
          );
          if (!response.ok) continue;
          const sample = parseBinanceDailyTakerDelta(await response.json(), now);
          if (sample === null) continue;
          delta += sample;
          completed++;
        } catch {
          // Missing sample is never replaced with a guessed value.
        }
      }
    }));
    // Do not present a one-symbol sample as capital flow for the market.
    const result: TakerDeltaSnapshot | null = completed >= 3
      ? { deltaUsd: Math.round(delta), sampledPairs: completed, requestedPairs: symbols.length, sampledAt: Date.now() }
      : null;
    cache = { at: Date.now(), utcDay, value: result };
    return result;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
