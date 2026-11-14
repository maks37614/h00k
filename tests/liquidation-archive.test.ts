import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {LiquidationArchive} from '../server/liquidationArchive';

const event = (id:string,usd=1000) => ({
  exchange:'binance' as const, symbol:'BTCUSDT', id,
  t:Date.now(), side:'LONG' as const, p:65000, q:0.02, usd,
});

test('archive is zero-IO by default and never polls exchange feeds', async () => {
  const archive=new LiquidationArchive(false,10,()=>{throw Error('DB should not be used')});
  archive.record(event('a'));
  await archive.flush();
  assert.equal(archive.stats().queued,0);
  assert.equal(archive.stats().enabled,false);
  assert.equal(await archive.heatmap('binance','BTCUSDT',24),null);
});

test('durable Liq archive batch uses idempotent event IDs and greatest cumulative fill', async () => {
  const calls: Array<{sql:string; values?:unknown[]}>= [];
  const fake={
    query:async(sql:string,values?:unknown[])=>{
      calls.push({sql,values});
      if(sql.includes('SELECT FLOOR')) return {rows:[]};
      return {rows:[],rowCount:0};
    },
  } as unknown as Pool;
  const archive=new LiquidationArchive(true,100,()=>fake);
  archive.record(event('one',1000));
  archive.record(event('two',2000));
  archive.record(event('one',4000));
  archive.record(event('one',500)); // stale cumulative fill ignored
  assert.equal(archive.stats().queued,2);
  await archive.flush();
  assert.equal(archive.stats().queued,0);
  assert.equal(archive.stats().batches,1);
  assert.equal(archive.stats().duplicateQueued,1);
  const insert=calls.find(c=>c.sql.includes('ON CONFLICT'));
  assert.ok(insert);
  assert.match(insert!.sql,/ON CONFLICT \(exchange,symbol,event_id\)/);
  assert.match(insert!.sql,/EXCLUDED\.observed_notional > h00k_liquidation_events\.observed_notional/);
  assert.equal(insert!.values?.length,16,'one row per unique ID, eight parameters each');
  assert.equal(insert!.values?.[7],4000);
  assert.equal(insert!.values?.[15],2000);
  assert.ok(calls.some(c=>c.sql.includes('CREATE TABLE IF NOT EXISTS h00k_liquidation_events')));
});

test('archive bounded queue never silently claims to save dropped events', () => {
  const archive=new LiquidationArchive(true,2,()=>{throw Error('No DB expected')});
  archive.record(event('a'));
  archive.record(event('b'));
  archive.record(event('c'));
  assert.equal(archive.stats().queued,2);
  assert.equal(archive.stats().droppedOnOverflow,1);
  archive.record({...event('a',1001),usd:3000});
  assert.equal(archive.stats().queued,2);
});

test('observed-only heatmap is grouped at timestamp and logarithmic price bins', async () => {
  const queries: string[]=[];
  const fake={
    query:async(sql:string)=>{
      queries.push(sql);
      if(sql.includes('SELECT FLOOR')) return {rows:[
        {t:1794600000,bin:2200,side:'LONG',amount:'8500',orders:'3'},
      ]};
      return {rows:[]};
    },
  } as unknown as Pool;
  const archive=new LiquidationArchive(true,5,()=>fake);
  const data=await archive.heatmap('binance','BTCUSDT',24);
  assert.equal(data?.complete,false);
  assert.equal(data?.truncated,false);
  assert.equal(data?.bins.length,1);
  assert.equal(data?.bins[0].usd,8500);
  assert.equal(data?.bins[0].count,3);
  assert.equal(data?.bins[0].time,1794600000*1000);
  assert.match(data!.caveat,/Лише отримані/);
  assert.equal(await archive.heatmap('binance','BTC\/USDT',168),null);
  assert.match(queries.at(-1)!,/LIMIT 6001/);
});

test('Postgres migration rejects invalid price values and has indexed event timestamp', () => {
  const sql=readFileSync(new URL('../server/migrations/003_liquidation_events.sql',import.meta.url),'utf8');
  assert.match(sql,/PRIMARY KEY \(exchange,symbol,event_id\)/);
  assert.match(sql,/price < 'Infinity'::float8/);
  assert.match(sql,/event_time DESC/);
  const feed=readFileSync(new URL('../server/liquidationFeed.ts',import.meta.url),'utf8');
  assert.match(feed,/liquidationArchive\.record/);
  assert.match(feed,/LIQ_MARKET_CAP/);
});
