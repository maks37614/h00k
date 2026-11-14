import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  aggregateLiquidationsByCandle,
  type Candle,
  type Liquidation,
} from '../src/components/hookchart/engine';

const minute = 60_000;
const start = 1_800_000_000_000;
const candle = (t: number): Candle => ({ t, o: 100, h: 105, l: 95, c: 101, v: 100, n: 10 });
const event = (
  id: string, offset: number, side: Liquidation['side'], usd: number,
): Liquidation => ({ id, t: start + offset, side, p: 100, q: usd / 100, usd });

test('Liq markers retain exact LONG/SHORT sums and counts per candle after memoization', () => {
  const candles = [candle(start), candle(start + minute), candle(start + 2 * minute)];
  const events = [
    event('a', 1_000, 'LONG', 300),
    event('b', 5_000, 'SHORT', 125),
    event('c', 20_000, 'LONG', 75),
    event('d', minute, 'SHORT', 400), // Exact candle boundary belongs to the second candle.
    event('e', minute + 59_999, 'LONG', 20),
    event('f', 2 * minute + 2_000, 'SHORT', 600),
  ];
  assert.deepEqual(aggregateLiquidationsByCandle(candles, events, minute), [
    { index: 0, t: start, totalUsd: 500, longUsd: 375, shortUsd: 125, count: 3 },
    { index: 1, t: start + minute, totalUsd: 420, longUsd: 20, shortUsd: 400, count: 2 },
    { index: 2, t: start + 2 * minute, totalUsd: 600, longUsd: 0, shortUsd: 600, count: 1 },
  ]);
});

test('Liq marker bucketing still rejects invalid or out-of-range events', () => {
  const candles = [candle(start), candle(start + minute)];
  const events = [
    event('before', -1, 'LONG', 100),
    event('after', 2 * minute, 'SHORT', 100),
    event('zero', 2_000, 'LONG', 0),
    event('negative', 2_000, 'SHORT', -100),
    { ...event('nan', 2_000, 'LONG', 100), t: NaN },
    event('valid', minute + 3_000, 'LONG', 125),
  ];
  assert.deepEqual(aggregateLiquidationsByCandle(candles, events, minute), [
    { index: 1, t: start + minute, totalUsd: 125, longUsd: 125, shortUsd: 0, count: 1 },
  ]);
  assert.deepEqual(aggregateLiquidationsByCandle(candles, [], minute), []);
  assert.deepEqual(aggregateLiquidationsByCandle([], events, minute), []);
});

test('Canvas reuses Liq candle buckets rather than re-aggregating on every cursor redraw', () => {
  const source = readFileSync(new URL('../src/components/hookchart/engine.tsx', import.meta.url), 'utf8');
  assert.match(source, /const liquidationBuckets=useMemo\(/);
  assert.match(source, /showLiquidations\?aggregateLiquidationsByCandle\(candles,liquidations,intervalMs\):\[\]/);
  assert.match(source, /\[showLiquidations,candles,liquidations,intervalMs\]/);
  assert.match(source, /for\(const bucket of liquidationBuckets\)/);
  assert.doesNotMatch(source, /for\(const bucket of aggregateLiquidationsByCandle\(/,
    'the draw loop must not perform O(events × log candles) bucketing on every frame');
});
