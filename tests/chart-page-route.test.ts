import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chartPageHash,readChartPageHash,sameChartPageRoute,
  saveChartPageSnapshot,readChartPageSnapshot,
  readChartReturnHash,saveChartReturnHash,safeReturnHash,
} from '../src/utils/chartPageRoute';
import { marketQuoteToChartCoin } from '../src/utils/chartPageCoin';
import type { ScannedCoin } from '../src/types';

const btc:ScannedCoin = {
  symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',exchange:'bybit',marketType:'futures',
  currentPrice:73456,priceChange24h:1.5,volume24hUsd:99_000_000,
  highPrice24h:75000,lowPrice24h:72500,formations:[],timeframe:'1h',
  lastUpdated:1,exchangeUrl:'',
};
function storage(){
  const data=new Map<string,string>();
  return {setItem:(k:string,v:string)=>{data.set(k,v)},getItem:(k:string)=>data.get(k)??null};
}

test('coin chart routes are standalone, shareable, and stable across navigation',()=>{
  const route={exchange:'bybit' as const,marketType:'futures' as const,
    symbol:'BTCUSDT',timeframe:'1h' as const,kind:'coin' as const};
  const hash=chartPageHash(route);
  assert.equal(hash,'#/chart/bybit/futures/BTCUSDT/1h');
  assert.deepEqual(readChartPageHash(hash),route);
  assert.ok(sameChartPageRoute(readChartPageHash(hash),route));
  assert.equal(sameChartPageRoute(route,{...route,timeframe:'5m'}),false);
});

test('archives and early scenarios preserve identity and safely encode formation ids',()=>{
  for(const kind of ['coin','early','archive'] as const){
    const route={exchange:'binance' as const,marketType:'spot' as const,
      symbol:'ETHUSDT',timeframe:'15m' as const,kind,formationId:'W/M:2026 11#12'};
    assert.deepEqual(readChartPageHash(chartPageHash(route)),route);
  }
});

test('unknown or unsafe chart hashes never enter the chart page',()=>{
  for(const hash of [
    '#screener','#/chart/binance/futures/BTCUSDT',
    '#/chart/hacker/futures/BTCUSDT/1h',
    '#/chart/bybit/margin/BTCUSDT/1h',
    '#/chart/bybit/futures/BTC/USDT/1h',
    '#/chart/bybit/futures/../../admin/1h',
    '#/chart/bybit/futures/BTCUSDT/2h',
    '#/chart/bybit/futures/%ZZ/1h',
  ]) assert.equal(readChartPageHash(hash),null,hash);
});

test('chart snapshots restore exact instrument without sharing across accounts',()=>{
  const st=storage(),route=readChartPageHash('#/chart/bybit/futures/BTCUSDT/1h')!;
  saveChartPageSnapshot(st,'trader-A',route,{coin:btc});
  assert.deepEqual(readChartPageSnapshot(st,'trader-A',route)?.coin,btc);
  assert.equal(readChartPageSnapshot(st,'trader-B',route),null);
  assert.equal(readChartPageSnapshot(st,'trader-A',{...route,timeframe:'4h'}),null);
  assert.equal(readChartPageSnapshot(st,'trader-A',{...route,symbol:'ETHUSDT'}),null);
});

test('missing or corrupted persisted data gracefully becomes a live coin chart',()=>{
  const st=storage(),route=readChartPageHash('#/chart/bybit/futures/BTCUSDT/1h')!;
  assert.equal(readChartPageSnapshot(st,'trader',route),null);
  saveChartPageSnapshot(st,'trader',route,{coin:{...btc,symbol:'ETHUSDT'}});
  assert.equal(readChartPageSnapshot(st,'trader',route),null);
});

test('return navigation never allows an arbitrary hash to be stored',()=>{
  const st=storage();
  saveChartReturnHash(st,'trader','#patterns');
  assert.equal(readChartReturnHash(st,'trader'),'#patterns');
  assert.equal(readChartReturnHash(st,'someone-else'),'#screener');
  assert.equal(safeReturnHash('#/chart/bybit/futures/BTCUSDT/1h'),'#screener');
  assert.equal(safeReturnHash('#nonsense'),'#screener');
});

test('a direct chart link uses only market quotes rather than a full-market scan',()=>{
  const coin=marketQuoteToChartCoin({
    symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',exchange:'bybit',
    marketType:'futures',price:73000,change24h:1.2,volumeUsd:1e8,
    high24h:75000,low24h:72000,distanceToHighPct:2,distanceToLowPct:1,
    volatility24hPct:2,isNearHigh:false,isNearLow:false,isActiveCoin:true,exchangeUrl:'',
  },'1h');
  assert.equal(coin.currentPrice,73000);
  assert.equal(coin.timeframe,'1h');
  assert.deepEqual(coin.formations,[]);
  assert.equal(coin.hasFormations,false);
});
