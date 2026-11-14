import test from 'node:test';
import assert from 'node:assert/strict';
import type { HookChartPreferences } from '../src/types';
import { HookChartDensityBook } from '../src/components/hookchart/densityBook';
import {
  createOrderBookLocalShareFloorLookup, orderBookLocalShareFloor,
  type OrderBookDensityLevel,
} from '../src/components/hookchart/marketAnalytics';

test('indexed BID/ASK local-share thresholds match the original full scan', () => {
  const levels: OrderBookDensityLevel[] = [];
  for (let i = 0; i < 850; i++) {
    const bid = +(100 - i * .003).toFixed(3);
    const ask = +(100 + i * .003).toFixed(3);
    levels.push({ side: 'BID', p: bid, q: (i % 17 + 1) * 2, usd: bid * (i % 17 + 1) * 2 });
    levels.push({ side: 'ASK', p: ask, q: (i % 11 + 1) * 3, usd: ask * (i % 11 + 1) * 3 });
  }
  // Two rows with the same side and price are excluded together, not just
  // the candidate row itself; real exchange books ordinarily have unique prices.
  levels.push({ ...levels[20], q: 4, usd: levels[20].p * 4 });
  for (const width of [0, .001, .5, 2, 20]) {
    for (const share of [0, .25, .5, .95]) {
      const indexed = createOrderBookLocalShareFloorLookup(levels, width, share);
      for (const item of levels.filter((_, i) => i % 17 === 0)) {
        const expected = orderBookLocalShareFloor(levels, item, width, share);
        const actual = indexed(item);
        assert.ok(Math.abs(expected - actual) <= Math.max(1e-6, Math.abs(expected) * 1e-9),
          `Mismatch for ${item.side} ${item.p}, width ${width}, share ${share}: ${actual} vs ${expected}`);
      }
    }
  }
});

test('depth books reuse level snapshots on hold-time ticks but invalidate on deltas and settings', () => {
  const now = Date.now();
  const depth = new HookChartDensityBook();
  const base = { densityDiffPct: 5, densityMode: 'manual', densityThreshold: 100 } as HookChartPreferences;
  assert.equal(depth.apply({
    bids: [[99, 10], [98, 12]], asks: [[101, 15], [102, 9]],
    sequence: 100, isSnapshot: true, eventTime: now,
  }, now), true);
  const first = depth.read(base, 1, now + 100);
  const holdTick = depth.read(base, 1, now + 200);
  assert.equal(first.depthReady, true);
  assert.strictEqual(holdTick.book, first.book);
  assert.equal(first.book.b[0].p, 99);
  assert.equal(first.book.b[0].q, 10);

  assert.equal(depth.apply({
    bids: [[99, 30]], asks: [], sequence: 101, eventTime: now + 300,
  }, now + 300), true);
  const updated = depth.read(base, 1, now + 301);
  assert.notStrictEqual(updated.book, first.book);
  assert.equal(updated.book.b[0].q, 30);

  const changedDistance = depth.read({ ...base, densityDiffPct: .1 }, 1, now + 302);
  assert.notStrictEqual(changedDistance.book, updated.book);
  assert.equal(changedDistance.book.b.length, 0);
  assert.equal(changedDistance.book.a.length, 0);

  depth.clear();
  const empty = depth.read(base, 1, now + 303);
  assert.equal(empty.depthReady, false);
  assert.deepEqual(empty.book, { b: [], a: [] });
});
