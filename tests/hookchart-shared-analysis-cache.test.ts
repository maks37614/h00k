import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimedRequestCache } from '../src/utils/sharedAnalysisKlines';

test('simultaneous HookChart instances share one analysis candle request', async () => {
  let now = 0, requests = 0;
  const cache = createTimedRequestCache<number[]>(45_000, 5, () => now);
  const fetcher = async () => { requests++; return [10, 11]; };
  const first = cache.load('binance:futures:BTCUSDT:1h:500', fetcher);
  const second = cache.load('binance:futures:BTCUSDT:1h:500', fetcher);
  assert.strictEqual(first, second, 'same in-flight promise is reused');
  assert.deepEqual(await Promise.all([first, second]), [[10,11],[10,11]]);
  assert.equal(requests, 1);
  assert.deepEqual(await cache.load('binance:futures:BTCUSDT:1h:500', fetcher), [10,11]);
  assert.equal(requests, 1);

  now = 45_001;
  await cache.load('binance:futures:BTCUSDT:1h:500', fetcher);
  assert.equal(requests, 2, 'expired result is refetched');
  await cache.load('bybit:futures:BTCUSDT:1h:500', fetcher);
  assert.equal(requests, 3, 'exchange scope is isolated');
});

test('failed requests are not cached; cache remains bounded', async () => {
  const cache = createTimedRequestCache<number>(10000, 2);
  await assert.rejects(cache.load('bad', async () => { throw new Error('network'); }), /network/);
  assert.equal(cache.size, 0);
  const a = await cache.load('bad', async () => 42);
  assert.equal(a, 42);
  await cache.load('2', async () => 2);
  await cache.load('3', async () => 3);
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
});
