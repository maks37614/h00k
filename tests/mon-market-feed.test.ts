import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { request } from 'node:http';
import { installMonMarketFeed } from '../server/monMarketFeed';
import { selectMonDensities } from '../server/formationDensityFeed';
import type { DensityItem } from '../server/surveillance/types';

test('Krystian market feed is private, bounded and read-only', async () => {
  const previous = process.env.HOOK_PAPER_FEED_TOKEN;
  process.env.HOOK_PAPER_FEED_TOKEN = 'test-'.padEnd(40,'x');
  const app = express();
  installMonMarketFeed(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port:number }).port;
  const get = (path: string, token?: string) => new Promise<{status:number;body:any}>( (resolve,reject) => {
    const req = request({hostname:'127.0.0.1',port,path,headers: token ? {
      Authorization:'Bearer '+token } : {}},res=>{
      let data='';
      res.on('data',chunk=>data+=chunk);
      res.on('end',()=>{
        let body:any={}; try{body=JSON.parse(data)}catch{}
        resolve({status:res.statusCode||0,body});
      });
    });
    req.on('error',reject);req.end();
  });
  try {
    assert.equal((await get('/api/mon/feed')).status,401);
    assert.equal((await get('/api/mon/feed','bad')).status,401);
    const ok=await get('/api/mon/feed',process.env.HOOK_PAPER_FEED_TOKEN);
    assert.equal(ok.status,200);
    assert.equal(ok.body.version,1);
    assert.ok(Array.isArray(ok.body.snapshots));
    assert.ok(Array.isArray(ok.body.density));
    assert.equal((await get('/api/mon/candles?exchange=binance&symbol=BTCUSDT&timeframe=1m&limit=99999',
      process.env.HOOK_PAPER_FEED_TOKEN)).status,400);
    assert.equal((await get('/api/mon/candles?exchange=binance&symbol=BTCUSDT&timeframe=1m&limit=180',
      process.env.HOOK_PAPER_FEED_TOKEN)).status,409);
  } finally {
    await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
    if(previous===undefined) delete process.env.HOOK_PAPER_FEED_TOKEN;
    else process.env.HOOK_PAPER_FEED_TOKEN=previous;
  }
});

test('Krystian feed preserves nearby genuine persistent BID and ASK walls under 30-item cap', () => {
  const make = (id: string, side: 'BID' | 'ASK', price: number,
    notionalUsd: number, classification: DensityItem['classification'] = 'PERSISTENT_LIQUIDITY'): DensityItem => ({
    id, side, price, quantity: notionalUsd / price, notionalUsd,
    distancePct: Math.abs(price - 1000) / 10,
    firstSeenAt: Date.now()-30_000, lastSeenAt: Date.now(),
    ageSeconds: 30, maxSizeUsd: notionalUsd, averageSizeUsd: notionalUsd,
    persistenceRatio: 1, classification, qualityScore: 80,
  });
  const far = Array.from({length:45},(_,i) =>
    make('far-'+i, i%2===0?'BID':'ASK',i%2===0?975:1025,2_000_000-i*100));
  const nearBid = make('near-bid','BID',999.6,70_000);
  const nearAsk = make('near-ask','ASK',1000.4,65_000);
  const all = [...far,nearBid,nearAsk];
  const chosen = selectMonDensities(all,1000);
  assert.equal(chosen.length,30);
  assert.equal(chosen[0].id,'near-bid');
  assert.equal(chosen[1].id,'near-ask');
  assert.ok(chosen.includes(nearBid));
  assert.ok(chosen.includes(nearAsk));
  assert.ok(chosen.every(row => all.includes(row)), 'no synthetic walls can be added');

  const fallback = selectMonDensities(far,1000);
  assert.deepEqual(fallback,far.slice(0,30), 'original notional ranking for no nearby persistent wall');
});

test('near-wall selection reserves both sides even when one side dominates', () => {
  const base = (side: 'BID'|'ASK', n: number): DensityItem => ({
    id: side+n, side, price: side==='BID'?999-n/1000:1000+n/1000,
    quantity: 100, notionalUsd: 100_000,
    distancePct: 0.1, firstSeenAt:1,lastSeenAt:2,ageSeconds:25,
    maxSizeUsd:100_000,averageSizeUsd:100_000,persistenceRatio:1,
    classification:'PERSISTENT_LIQUIDITY', qualityScore:55,
  });
  const book=[...Array.from({length:36},(_,i)=>base('BID',i+1)),base('ASK',1)];
  const chosen=selectMonDensities(book,1000);
  assert.equal(chosen.length,30);
  assert.ok(chosen.some(row=>row.side==='ASK'), 'keep a confirmed ASK wall');
});
