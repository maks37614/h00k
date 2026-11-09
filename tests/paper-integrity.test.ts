import test from 'node:test';
import assert from 'node:assert/strict';
import { formationCandleData, fetchKlines, getPaperMarketSnapshot, runScreenerScan } from '../server/marketService';
import { finalizeFormationGeometry, detectFormations } from '../src/utils/patternRecognition';
import type { DetectedFormation, Kline } from '../src/types';

const now = 1_793_000_040_000; // Fixed minute boundary; no exchange/network dependency.
const rows = (end: number, count = 70): Kline[] => Array.from({ length: count }, (_, i) => ({
  time: end / 1000 - (count - i) * 60, open: 100, high: 101, low: 99, close: 100, volume: 10,
}));

test('formation provenance rejects stale, future, gapped and malformed real-source inputs', () => {
  const data = rows(now);
  assert.deepEqual(formationCandleData(data, '1m', now, now), { collectedAt: now, lastClosedAt: now, contiguous: true });
  assert.equal(formationCandleData(data, '1m', now - 181_000, now), null);
  assert.equal(formationCandleData(data, '1m', now + 1, now), null);
  assert.equal(formationCandleData(data.filter((_, i) => i !== 35), '1m', now, now), null);
  for (const invalid of [{ high: 90 }, { close: NaN }, { volume: -1 }, { time: data[35].time + 1 }]) {
    assert.equal(formationCandleData(data.map((c, i) => i === 35 ? { ...c, ...invalid } : c), '1m', now, now), null);
  }
  assert.equal(formationCandleData(rows(now - 180_000), '1m', now, now), null, 'new HTTP collection cannot make old market candles fresh');
});

test('a candle fetched before its close never becomes final merely because wall clock advances', () => {
  const data = [...rows(now), { time: now / 1000, open: 100, high: 900, low: 1, close: 500, volume: 10 }];
  const provenance = formationCandleData(data, '1m', now + 30_000, now + 90_000);
  assert.equal(provenance?.lastClosedAt, now, 'the later incomplete candle remains excluded');
});

test('the actual candle export excludes an incomplete cached candle even on a later read', async () => {
  const previousFetch = globalThis.fetch; const previousNow = Date.now;
  Date.now = () => now + 30_000;
  globalThis.fetch = async () => Response.json([...rows(now), { time: now/1000, open: 100, high: 900, low: 1, close: 500, volume: 10 }]
    .map(c => [c.time*1000,c.open,c.high,c.low,c.close,c.volume]));
  try {
    await fetchKlines('binance','futures','PARTIALUSDT','1m');
    const exported = getPaperMarketSnapshot(['binance:futures:PARTIALUSDT'],['1m'],now+90_000);
    assert.equal(exported.series[0].candles.length,70);
    assert.equal(exported.series[0].candles.at(-1)?.[0],now/1000-60);
    assert.equal(exported.series[0].updatedAt,now+30_000);
  } finally { globalThis.fetch=previousFetch; Date.now=previousNow; }
});

test('an exchange candle failure cannot produce a freshly stamped formation from the old cache', async () => {
  const previousFetch = globalThis.fetch; const previousNow = Date.now;
  let clock=now; let candleFails=false;
  Date.now = () => clock;
  globalThis.fetch = async input => {
    if (String(input).includes('tickers')) return Response.json({ retCode:0,result:{list:[{
      symbol:'PROVENANCEUSDT',lastPrice:'100',price24hPcnt:'0',turnover24h:'10000000',highPrice24h:'110',lowPrice24h:'90',
    }]}});
    if (candleFails) return new Response('',{status:503});
    return Response.json({retCode:0,result:{list:rows(now).reverse().map(c=>[c.time*1000,c.open,c.high,c.low,c.close,c.volume])}});
  };
  try {
    const params={exchange:'bybit' as const,marketType:'spot' as const,timeframe:'1m' as const};
    const first=await runScreenerScan(params);
    assert.equal(first.length,1); assert.equal(first[0].formationData?.collectedAt,now);
    clock+=181_000; candleFails=true;
    assert.deepEqual(await runScreenerScan(params),[], 'fresh tickers cannot conceal unavailable final candles');
  } finally { globalThis.fetch=previousFetch; Date.now=previousNow; }
});

test('geometry preserves measured levels without manufactured stops, targets or minimum R:R', () => {
  const base: DetectedFormation = {
    id: 'measured', patternKey: 'double_bottom', name: 'W', nameEn: 'W', category: 'reversal', bias: 'bullish',
    confidence: 80, status: 'breakout', statusLabel: '', description: '', detectedAt: now,
    levels: { entryPrice: 100, stopLossPrice: 98, targetPrice: 100.01 },
    potentialProfitPct: 0, potentialRiskPct: 0, riskRewardRatio: 0,
  };
  for (const bias of ['bullish', 'bearish', 'neutral'] as const) {
    const raw = { ...base, bias, levels: { entryPrice: 100, stopLossPrice: 0, targetPrice: 0 } };
    const result = finalizeFormationGeometry(raw, 100);
    assert.deepEqual(result.levels, { ...raw.levels, supportPrice: undefined, resistancePrice: undefined, necklinePrice: undefined });
    assert.equal(result.riskRewardRatio, 0);
  }
  assert.equal(finalizeFormationGeometry(base, 100).riskRewardRatio, .01, 'a tiny measured reward is not floored to .5R');
  const closeToTarget = finalizeFormationGeometry({ ...base, levels: { entryPrice: 100, stopLossPrice: 98, targetPrice: 106 } }, 105.9);
  assert.equal(closeToTarget.status, 'breakout', 'being near a target is not an actual target touch');
});

test('minute formation identities retain their actual timeframe', () => {
  const end = Math.floor(Date.now() / 60_000) * 60;
  const data = Array.from({ length: 70 }, (_, i) => {
    const price = 100 + Math.sin(i / 3) * 4;
    return { time: end - (70 - i) * 60, open: price, high: price + 1, low: price - 1, close: price + .1, volume: 100 };
  });
  const found = detectFormations(data, 'AUDITUSDT');
  assert.ok(found.length > 0, 'fixture must exercise an actual detected formation');
  for (const formation of found) assert.match(formation.id, /-1m-/, formation.id);
});

test('both exchange candle caches have one bounded memory pool and exports never fetch missing coins', async () => {
  const previous = globalThis.fetch;
  const stamp = Math.floor(Date.now() / 60_000) * 60_000;
  let calls = 0;
  globalThis.fetch = async input => {
    calls++;
    const data = rows(stamp).map(c => [c.time * 1000, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume)]);
    return String(input).includes('bybit') ? Response.json({ retCode: 0, result: { list: data.reverse() } }) : Response.json(data);
  };
  try {
    for (let i = 0; i < 501; i++) await fetchKlines(i % 2 ? 'binance' : 'bybit', 'futures', `AUDIT${i}USDT`, '1m');
    const before = calls;
    const exported = getPaperMarketSnapshot(['bybit:futures:AUDIT0USDT', 'bybit:futures:AUDIT500USDT', 'binance:futures:NOTCACHEDUSDT'], ['1m']);
    assert.equal(exported.series.length, 1);
    assert.equal(exported.series[0].instrument, 'bybit:futures:AUDIT500USDT');
    assert.equal(calls, before, 'reading cache neither refreshes it nor fetches unknown instruments');
  } finally { globalThis.fetch = previous; }
});
