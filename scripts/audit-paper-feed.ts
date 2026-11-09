/** Local fixture benchmark only. Never contacts h00k.top or a real exchange. */
import express from 'express';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { fetchKlines } from '../server/marketService';
import { marketTickerFeed } from '../server/marketTickerFeed';
import { installPaperFeed } from '../server/paperFeed';

const frames = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const instruments = Array.from({ length: 12 }, (_, i) => `AUDIT${i}USDT`);
const previousFetch = globalThis.fetch;
const previousToken = process.env.HOOK_PAPER_FEED_TOKEN;
let fixtureCalls = 0;
globalThis.fetch = async input => {
  fixtureCalls++;
  const url = new URL(String(input));
  if (url.pathname.includes('ticker')) return Response.json(instruments.map(symbol => ({ symbol,
    lastPrice: '100', priceChangePercent: '1', quoteVolume: '10000000', highPrice: '105', lowPrice: '95' })));
  const seconds = frames[url.searchParams.get('interval') as keyof typeof frames];
  assert.ok(seconds);
  const end = Math.floor(Date.now() / (seconds * 1000)) * seconds;
  return Response.json(Array.from({ length: 200 }, (_, i) => [
    (end - (200 - i) * seconds) * 1000, '100.12345678', '101.12345678', '99.12345678', '100.52345678', '12345.6789',
  ]));
};
const app = express();
installPaperFeed(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  await marketTickerFeed.get('binance', 'futures');
  for (const symbol of instruments) for (const timeframe of Object.keys(frames)) {
    await fetchKlines('binance', 'futures', symbol, timeframe as keyof typeof frames, 200);
  }
  const warmedCalls = fixtureCalls;
  process.env.HOOK_PAPER_FEED_TOKEN = 'local-fixture-only-'.repeat(4);
  globalThis.fetch = async () => { fixtureCalls++; throw new Error('Export attempted external work'); };
  const params = new URLSearchParams({ watch: instruments.map(symbol => `binance:futures:${symbol}`).join(','),
    tfs: Object.keys(frames).join(','), formationTf: '1m' });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/paper/formations?${params}`;
  const durations: number[] = [];
  const cpuStart = process.cpuUsage(); const start = performance.now(); let bytes = 0;
  for (let i = 0; i < 60; i++) {
    const begin = performance.now();
    const response: Response = await previousFetch(base, { headers: { Authorization: `Bearer ${process.env.HOOK_PAPER_FEED_TOKEN}` } });
    assert.equal(response.status, 200);
    const body = await response.text(); bytes = Buffer.byteLength(body);
    const data = JSON.parse(body);
    assert.equal(data.market.series.length, 72);
    assert.equal(data.market.series.reduce((sum: number, series: any) => sum + series.candles.length, 0), 14_400);
    durations.push(performance.now() - begin);
  }
  const elapsedMs = performance.now() - start; const cpu = process.cpuUsage(cpuStart);
  durations.sort((a,b) => a-b);
  assert.equal(fixtureCalls, warmedCalls, 'exports must perform zero collection calls');
  console.log(JSON.stringify({ environment: 'local synthetic fixture; not VPS measurement', node: process.version,
    requests: 60, instruments: 12, timeframes: 6, candles: 14_400, bytesPerResponse: bytes,
    elapsedMs: Math.round(elapsedMs), cpuMs: Math.round((cpu.user+cpu.system)/1000),
    medianMs: +durations[30].toFixed(2), p95Ms: +durations[56].toFixed(2),
    externalCallsDuringExports: fixtureCalls-warmedCalls, liveSiteRequests: 0 }, null, 2));
} finally {
  globalThis.fetch = previousFetch;
  if (previousToken === undefined) delete process.env.HOOK_PAPER_FEED_TOKEN;
  else process.env.HOOK_PAPER_FEED_TOKEN = previousToken;
  await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
}
