import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { captureChartDocument } from '../src/community/chartDocument';
const built=await build({entryPoints:[fileURLToPath(new URL('../src/components/community/SharedHookChart.tsx',import.meta.url))],bundle:true,write:false,format:'cjs',platform:'node',packages:'external',plugins:[{name:'styles-in-node-fixture',setup(b){b.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}));}}]});
const compiled={exports:{} as any};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),compiled,compiled.exports);
test('minimal HookChart renders timeframe/history/drawing tools with zero exchange fetches and no settings panel',()=>{
  const previousFetch=globalThis.fetch,previousWs=globalThis.WebSocket;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('Rendering must not request a network feed');};
  globalThis.WebSocket=class{constructor(){calls++;throw new Error('Rendering must not start a socket');}}as any;
  try{
    const t=Math.floor(Date.now()/1000)-600;
    const document=captureChartDocument({symbol:'BTCUSDT',exchange:'binance',marketType:'futures',timeframe:'1m',candles:[{time:t,open:100,high:110,low:95,close:105,volume:12}],markers:[],drawings:[]});
    const html=renderToString(React.createElement(compiled.exports.default,{value:document,onChange(){},onHistory:async()=>[]}));
    assert.match(html,/data-network-mode="snapshot"/);assert.match(html,/Таймфрейми та інструменти графіка/);assert.match(html,/Панель малювання/);assert.match(html,/Історія/);assert.match(html,/4h/);assert.match(html,/До знімка/);assert.doesNotMatch(html,/originalSettingsBackdrop|Налаштування hookchart/);assert.equal(calls,0);
  }finally{globalThis.fetch=previousFetch;globalThis.WebSocket=previousWs;}
});
