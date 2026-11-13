import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker=readFileSync(new URL('../server/surveillance/coinWorker.ts',import.meta.url),'utf8');
const shared=readFileSync(new URL('../server/surveillance/sharedCandleFeed.ts',import.meta.url),'utf8');

test('one instrument has exactly one OHLCV event handler, shared across all users',()=>{
  assert.match(shared,/const candleFeeds = new Map<string,SharedCandleEntry>\(\)/);
  assert.match(shared,/const key=\x60\$\{exchange\}:\$\{market\}:\$\{clean\}\x60/);
  assert.match(shared,/source\.on\('trade',\(trade:RawTradeEvent\)=>/);
  assert.match(shared,/if\(created\.initialized\) created\.engine\.updateWithTrade\(trade\)/);
  assert.match(shared,/entry\.refs\+\+/);
  assert.match(shared,/if\(--current\.refs===0/);
  assert.doesNotMatch(worker,/this\.mtfEngine\.updateWithTrade\(trade\)/);
});

test('shared historical candles load once per market and replay only recent buffered trades',()=>{
  assert.match(shared,/Promise\.all\(frameSpecs\.map/);
  assert.match(shared,/ready=prime\(created,exchange,market,clean\)/);
  assert.match(shared,/trade\.time >= lastSnapshotBucket/);
  assert.match(worker,/await this\.candleFeed\.ready/);
  assert.match(worker,/this\.candleFeed\.destroy\(\)/);
  assert.doesNotMatch(worker,/private async loadInitialHistory/);
});

test('per-user trade flow, DOM threshold, notification decisions remain independent',()=>{
  assert.match(worker,/this\.volumeOIEngine = new VolumeAndOIEngine\(\)/);
  assert.match(worker,/this\.orderBookEngine = new OrderBookEngine/);
  assert.match(worker,/this\.volumeOIEngine\.addTrade\(trade\)/);
  assert.match(worker,/this\.orderBookEngine\.updateConfig/);
  assert.match(worker,/this\.coin\.config\.formationThreshold/);
  assert.match(worker,/userId: this\.coin\.userId/);
});
