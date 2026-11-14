import { useEffect } from 'react';
import {
  validateHeatmapSnapshot,
  type LiquidationHeatmapSnapshot,
  type LiquidationHeatmapPeriod,
} from './liquidationHeatmap';

type Exchange = 'binance' | 'bybit';
type Status = 'loading' | 'available' | 'empty' | 'disabled' | 'error';
type Props = {
  exchange: Exchange;
  symbol: string;
  period: LiquidationHeatmapPeriod;
  onData: (data: LiquidationHeatmapSnapshot | null) => void;
  onStatus: (status: Status) => void;
};
type Result = { data: LiquidationHeatmapSnapshot | null; status: Status };

const CACHE_MS = 55_000;
const cache = new Map<string,{at:number;result:Result}>();
const inFlight = new Map<string,Promise<Result>>();

/** Shared requests per browser tab; even 20 Terminal charts showing the same
 * coin never make 20 independent API requests.
 */
export async function fetchSharedObservedHeatmap(
  exchange: Exchange,
  symbol: string,
  period: LiquidationHeatmapPeriod,
): Promise<Result> {
  const key=`${exchange}:${symbol}:${period}`;
  const hit=cache.get(key);
  if(hit && Date.now()-hit.at<CACHE_MS)return hit.result;
  const pending=inFlight.get(key);
  if(pending)return pending;
  const task=(async():Promise<Result>=>{
    try {
      const response=await fetch('/api/hookchart/liquidation-heatmap?'+new URLSearchParams({
        exchange,symbol,period,
      }), {signal:AbortSignal.timeout(10_000)});
      if(response.status===404)return {data:null,status:'disabled'};
      if(!response.ok)return {data:null,status:'error'};
      const raw=await response.json();
      const parsed=validateHeatmapSnapshot(raw?.data,exchange,symbol,period);
      if(!raw?.success || !parsed)return {data:null,status:'error'};
      return {data:parsed,status:parsed.bins.length?'available':'empty'};
    }catch{return {data:null,status:'error'};}
  })();
  inFlight.set(key,task);
  try {
    const result=await task;
    if(cache.size>=40)cache.delete(cache.keys().next().value!);
    cache.set(key,{at:Date.now(),result});
    return result;
  }finally{
    if(inFlight.get(key)===task)inFlight.delete(key);
  }
}

/**
 * Mounted ONLY while user turns on the Liq map; lazy-loaded in a separate Vite
 * chunk. When off: no fetches, timers, event listeners or extra paint work.
 */
export default function LiquidationHeatmapLoader({
  exchange,symbol,period,onData,onStatus,
}: Props) {
  useEffect(()=>{
    let alive=true;
    let busy=false;
    const refresh=async()=>{
      if(busy||document.visibilityState==='hidden')return;
      busy=true;
      const result=await fetchSharedObservedHeatmap(exchange,symbol,period);
      busy=false;
      if(!alive)return;
      onData(result.data);
      onStatus(result.status);
      if(result.status==='disabled'){
        clearInterval(timer);
        document.removeEventListener('visibilitychange',onVisible);
      }
    };
    const onVisible=()=>{if(document.visibilityState==='visible')void refresh();};
    onStatus('loading');
    void refresh();
    const timer=setInterval(()=>void refresh(),60_000);
    document.addEventListener('visibilitychange',onVisible);
    return ()=>{
      alive=false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange',onVisible);
    };
  },[exchange,symbol,period,onData,onStatus]);
  return null;
}
