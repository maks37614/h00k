import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candleFingerprint, SharedMarketAnalysisCache } from '../server/surveillance/sharedMarketAnalysis';

const candle=(v:number)=>({time:1700000000000,open:v,high:v+1,low:v-1,close:v,volume:10});

test('two owners with identical public OHLCV reuse exactly one market computation',()=>{
  const cache=new SharedMarketAnalysisCache<{zones:number[];patterns:string[]}>(6000,10);
  const key='binance:futures:BTCUSDT';
  const fingerprint=candleFingerprint([[candle(100)],[candle(200)]]);
  let computations=0;
  const calc=()=>{computations++;return {zones:[100],patterns:['W']};};
  assert.deepEqual(cache.get(key,fingerprint,calc,10000),{zones:[100],patterns:['W']});
  assert.deepEqual(cache.get(key,fingerprint,calc,11000),{zones:[100],patterns:['W']});
  assert.equal(computations,1);
  assert.equal(cache.stats().hits,1);
});

test('new candles, different exchanges and TTL expiry never reuse stale analysis',()=>{
  const cache=new SharedMarketAnalysisCache<number>(6000,2);
  let n=0;const calculate=()=>++n;
  const first=candleFingerprint([[candle(100)]]);
  const changed=candleFingerprint([[candle(102)]]);
  assert.notEqual(first,changed);
  assert.equal(cache.get('binance:futures:BTCUSDT',first,calculate,10000),1);
  assert.equal(cache.get('binance:futures:BTCUSDT',changed,calculate,11000),2);
  assert.equal(cache.get('bybit:futures:BTCUSDT',changed,calculate,12000),3);
  assert.equal(cache.get('binance:futures:BTCUSDT',changed,calculate,12000),2);
  assert.equal(cache.get('binance:futures:BTCUSDT',changed,calculate,18001),4);
  assert.ok(cache.stats().entries<=2);
});

test('workers share only market values and retain personal threshold and tracking state',()=>{
  const worker=readFileSync(new URL('../server/surveillance/coinWorker.ts',import.meta.url),'utf8');
  const levels=readFileSync(new URL('../server/surveillance/levelsAndFormationsEngine.ts',import.meta.url),'utf8');
  assert.match(worker,/sharedMarketAnalysis\.get\(/);
  assert.match(worker,/this\.coin\.exchange.*this\.coin\.marketType.*this\.coin\.symbol/);
  assert.match(worker,/this\.levelsEngine\.adoptSharedZones\(shared\.zones\)/);
  assert.match(worker,/shared\.patterns\)[\s\S]{0,100}formationThreshold/);
  assert.match(worker,/this\.setupEngine\.evaluateSetups/);
  assert.match(levels,/public adoptSharedZones\(zones: readonly LevelZone\[\]\)/);
  const mtf=readFileSync(new URL('../server/surveillance/multiTimeframeEngine.ts',import.meta.url),'utf8');
  const start=mtf.indexOf('public analyzeStructure(');
  const finish=mtf.indexOf('public getMultiTimeframeStructures(',start);
  assert.ok(start>=0 && finish>start);
  assert.equal((mtf.slice(start,finish).match(/currentPrice/g)||[]).length,1,
    'Future price-sensitive structure calculations must be included in the shared fingerprint');
});
