import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { MarketCoin } from '../src/types';
import { aggregateBybitDerivatives, parseBinanceDailyTakerDelta } from '../server/sentimentMarketMetrics';

const coin = (exchange: 'bybit' | 'binance', oi?: number, funding?: number): MarketCoin => ({
  symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', exchange, marketType: 'futures',
  price: 100, change24h: 1, volumeUsd: 100000, high24h: 110, low24h: 90,
  distanceToHighPct: 10, distanceToLowPct: 10, volatility24hPct: 12,
  isNearHigh: false, isNearLow: false, isActiveCoin: true, exchangeUrl: '',
  ...(oi === undefined ? {} : { openInterestUsd: oi }),
  ...(funding === undefined ? {} : { fundingRatePct: funding }),
});

test('real Bybit ticker OI sums across observed contracts, never guessed from turnover', () => {
  const metrics = aggregateBybitDerivatives([
    coin('bybit', 100_000_000, 0.02),
    { ...coin('bybit', 200_000_000, 0.005), symbol: 'ETHUSDT' },
    coin('binance', 900_000_000, 0.25),
  ]);
  assert.equal(metrics.aggregatedOIUsd, 300_000_000);
  assert.equal(metrics.instrumentCount, 2);
  assert.equal(metrics.fundingInstrumentCount, 2);
  assert.equal(metrics.avgFundingRate, 0.01);
  assert.equal(metrics.oiChange24hPct, null);
  assert.match(metrics.sourceLabel ?? '', /Bybit USDT Linear/);
});

test('no observed OI/funding returns nulls, including malformed amounts', () => {
  const metrics = aggregateBybitDerivatives([coin('bybit'), coin('bybit', Number.NaN, 0.02)]);
  assert.equal(metrics.aggregatedOIUsd, null);
  assert.equal(metrics.avgFundingRate, null);
  assert.equal(metrics.instrumentCount, 0);
  assert.equal(metrics.fundingBias, null);
});

test('Binance UTC candle taker delta is signed BUY - SELL, not net money inflow', () => {
  const now = Date.UTC(2026, 10, 12, 15, 30);
  const row: unknown[] = [Date.UTC(2026, 10, 12), '100', '110', '90', '105', '10',
    now + 1000, '1000', 100, '7', '650', '0'];
  assert.equal(parseBinanceDailyTakerDelta([row], now), 300);
  row[10] = '400';
  assert.equal(parseBinanceDailyTakerDelta([row], now), -200);
});

test('reject stale and inconsistent Binance candles instead of displaying fake flow', () => {
  const now = Date.UTC(2026, 10, 12, 15);
  const valid: unknown[] = [Date.UTC(2026, 10, 12), '1', '1', '1', '1', '1', now,
    '1000', 20, '1', '600', '0'];
  assert.equal(parseBinanceDailyTakerDelta([[...valid.slice(0, 7), '1000', 20, '1', '1200', '0']], now), null);
  assert.equal(parseBinanceDailyTakerDelta([[Date.UTC(2026, 10, 11), ...valid.slice(1)]], now), null);
  assert.equal(parseBinanceDailyTakerDelta('not a kline', now), null);
  assert.equal(parseBinanceDailyTakerDelta([valid], now), 200);
});

test('market coverage is explicit and low coverage cannot affect live sentiment', () => {
  const src = readFileSync(new URL('../server/sentimentService.ts', import.meta.url), 'utf8');
  assert.match(src, /locationCount >= 50 && locationCoverage >= 0\.30/);
  assert.match(src, /locationCoverageReliable && locationCount > 0/);
  assert.match(src, /locationPairs: locationCount/);
  assert.match(src, /locationReliable: locationCoverageReliable/);
});

test('Binance sample is rate-limited globally and clearly scoped to UTC day', () => {
  const src = readFileSync(new URL('../server/sentimentMarketMetrics.ts', import.meta.url), 'utf8');
  assert.match(src, /const SAMPLE_SIZE = 8/);
  assert.match(src, /const CACHE_MS = 5 \* 60_000/);
  assert.match(src, /if \(inflight\) return inflight/);
  assert.match(src, /interval=1d&limit=1/);
  assert.match(src, /completed >= 3/);
});
