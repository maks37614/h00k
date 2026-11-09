import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { installPaperFeed } from '../server/paperFeed';
import { fetchKlines, getPaperFormationSnapshots, getPaperMarketSnapshot, runScreenerScan } from '../server/marketService';
import { MarketTickerFeed, marketTickerFeed } from '../server/marketTickerFeed';

test('feed is disabled by default, checks its own credential and bounds selections', async () => {
  const previous = process.env.HOOK_PAPER_FEED_TOKEN;
  const app = express();
  installPaperFeed(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/paper/formations`;
  const token = 'x'.repeat(64);
  const request = (credential = '', query = '') => fetch(base + query, { headers: { Authorization: `Bearer ${credential}` } });
  try {
    delete process.env.HOOK_PAPER_FEED_TOKEN;
    assert.equal((await request()).status, 503);
    process.env.HOOK_PAPER_FEED_TOKEN = 'short';
    assert.equal((await request('short')).status, 503);
    process.env.HOOK_PAPER_FEED_TOKEN = token;
    assert.equal((await request()).status, 401);
    assert.equal((await request('wrong')).status, 401);
    for (const query of [
      'watch=' + Array.from({ length: 13 }, () => 'binance:futures:BTCUSDT').join(','),
      'watch=binance:futures:BTCUSDT/../../x', 'watch[]=binance:futures:BTCUSDT',
      'watch=a&watch=b', 'tfs=2m', 'tfs[]=1m', 'tfs=' + Array(7).fill('1m').join(','),
      'formationTf=2m', 'formationTf[]=1m', 'formationTf=',
    ]) assert.equal((await request(token, '?' + query)).status, 400, query);

    const before = getPaperFormationSnapshots();
    const result = await request(token);
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const body = await result.json();
    assert.equal(body.version, 2);
    assert.equal(body.success, false);
    assert.deepEqual(body.snapshots, before);
    assert.deepEqual(body.market, { quotes: [], series: [] });
    assert.equal(body.sources.length, 4);
    assert.equal(body.collection.candidateBudget, 75);
    assert.ok(Array.isArray(body.collection.timeframes));
    assert.deepEqual(getPaperFormationSnapshots(), before);
    const previousFrames = process.env.HOOK_SCREENER_TIMEFRAMES;
    try {
      process.env.HOOK_SCREENER_TIMEFRAMES = '1m,2m';
      const invalid = await request(token);
      assert.equal(invalid.status, 503);
      assert.equal((await invalid.json()).error, 'Invalid background formation timeframe configuration');
    } finally {
      if (previousFrames === undefined) delete process.env.HOOK_SCREENER_TIMEFRAMES;
      else process.env.HOOK_SCREENER_TIMEFRAMES = previousFrames;
    }
  } finally {
    if (previous === undefined) delete process.env.HOOK_PAPER_FEED_TOKEN;
    else process.env.HOOK_PAPER_FEED_TOKEN = previous;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('v2 exports only existing recent candle cache and original quote times without network work', async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.HOOK_PAPER_FEED_TOKEN;
  const stamp = Math.floor(Date.now() / 60_000) * 60;
  let calls = 0;
  globalThis.fetch = async input => {
    calls++;
    const url = String(input);
    if (url.includes('ticker/24hr')) return Response.json([
      { symbol: 'BTCUSDT', lastPrice: '100', priceChangePercent: '1', quoteVolume: '1000000', highPrice: '110', lowPrice: '90' },
    ]);
    assert.match(url, /klines/);
    return Response.json(Array.from({ length: 230 }, (_, i) => [
      (stamp - (230 - i) * 60) * 1000, '100', '101', '99', '100', '10',
    ]));
  };
  const app = express();
  installPaperFeed(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await marketTickerFeed.get('binance', 'futures');
    await fetchKlines('binance', 'futures', 'BTCUSDT', '1m', 500);
    await fetchKlines('binance', 'futures', 'BTCUSDT', '5m', 500, stamp * 1000 - 600_000, stamp * 1000);
    const callsAfterCollection = calls;
    assert.equal(callsAfterCollection, 3);
    const first = getPaperMarketSnapshot(['binance:futures:BTCUSDT'], ['1m', '5m']);
    assert.equal(first.series.length, 1, 'historical query cache must be excluded');
    assert.equal(first.series[0].candles.length, 200);
    assert.equal(first.series[0].candles[0][0], stamp - 200 * 60);
    const collected = first.series[0].updatedAt;
    assert.equal(first.quotes[0].updatedAt, marketTickerFeed.cached()[0].updatedAt);
    for (let i = 0; i < 5; i++) {
      const exported = getPaperMarketSnapshot(['binance:futures:BTCUSDT'], ['1m']);
      assert.equal(exported.series[0].updatedAt, collected);
    }
    assert.equal(getPaperMarketSnapshot(['bybit:futures:BTCUSDT'], ['1m']).series.length, 0);
    assert.equal(getPaperMarketSnapshot(['binance:futures:BTCUSDT'], ['5m']).series.length, 0);
    assert.equal(getPaperMarketSnapshot(['binance:futures:BTCUSDT'], ['1m'], Date.now() + 181_000).series.length, 0);
    assert.equal(getPaperMarketSnapshot(['binance:futures:BTCUSDT'], ['1m'], collected - 1).series.length, 0);

    process.env.HOOK_PAPER_FEED_TOKEN = 'x'.repeat(64);
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/paper/formations`;
    const response = await previousFetch(base + '?watch=binance:futures:BTCUSDT&tfs=1m&formationTf=1m', {
      headers: { Authorization: `Bearer ${process.env.HOOK_PAPER_FEED_TOKEN}` },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.version, 2);
    assert.equal(body.success, true);
    assert.equal(body.market.series.length, 1);
    assert.equal(body.market.series[0].updatedAt, collected);
    assert.equal(body.market.quotes[0].price, 100);
    assert.equal(calls, callsAfterCollection, 'all exports reuse memory without contacting exchanges');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.HOOK_PAPER_FEED_TOKEN;
    else process.env.HOOK_PAPER_FEED_TOKEN = previousToken;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('formations export filters timeframe and age without starting another scan', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  // A successful, nonempty ticker snapshot is needed to verify shared caching.
  // Empty lists are invalid exchange responses and correctly try a mirror.
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ retCode: 0, result: { list: [
      { symbol: 'DUMMYUSDT', lastPrice: '100', price24hPcnt: '0',
        turnover24h: '1', highPrice24h: '101', lowPrice24h: '99' },
    ] } });
  };
  try {
    await runScreenerScan({ exchange: 'bybit', marketType: 'spot', timeframe: '1m' });
    await runScreenerScan({ exchange: 'bybit', marketType: 'spot', timeframe: '1h' });
    const afterScan = calls;
    assert.equal(afterScan, 1, 'existing shared ticker cache is reused');
    const minute = getPaperFormationSnapshots(Date.now(), '1m');
    assert.equal(minute.length, 1);
    assert.match(minute[0].key, /_1m_/);
    const hour = getPaperFormationSnapshots(Date.now(), '1h');
    assert.equal(hour.length, 1);
    assert.match(hour[0].key, /_1h_/);
    assert.equal(getPaperFormationSnapshots(Date.now() + 181_000).length, 0);
    assert.equal(calls, afterScan);
  } finally { globalThis.fetch = previousFetch; }
});

test('ticker cache reads retain the source timestamp even when stale', async () => {
  let calls = 0;
  let clock = Date.now();
  const feed = new MarketTickerFeed(async () => {
    calls++;
    return Response.json([{ symbol: 'BTCUSDT', lastPrice: '100', priceChangePercent: '1', quoteVolume: '1000000', highPrice: '110', lowPrice: '90' }]);
  }, () => clock);
  assert.deepEqual(feed.cached(), []);
  assert.equal(calls, 0);
  await feed.get('binance', 'futures');
  const when = feed.cached()[0].updatedAt;
  clock += 300_000;
  assert.equal(feed.cached()[0].updatedAt, when);
  assert.equal(feed.cached()[0].data[0].symbol, 'BTCUSDT');
  assert.equal(calls, 1);
});
