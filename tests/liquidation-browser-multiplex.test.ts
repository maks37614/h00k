import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMultiplexBrowserLiquidations} from '../src/components/hookchart/liquidationMultiplexClient';

class FakeClient {
  static OPEN=1;
  readyState=0;
  onopen: (()=>void)|null=null;
  onmessage: ((event:{data:string})=>void)|null=null;
  onerror: (()=>void)|null=null;
  onclose: (()=>void)|null=null;
  sent: Array<Record<string, unknown>>=[];
  constructor(readonly url:string){}
  open(){this.readyState=1;this.onopen?.();}
  send(text:string){this.sent.push(JSON.parse(text));}
  deliver(packet:unknown){this.onmessage?.({data:JSON.stringify(packet)});}
  close(){this.readyState=3;this.onclose?.();}
}

test('optional browser Liq multiplex shares ONE socket for distinct coins without mixing data', () => {
  const savedWindow=(globalThis as any).window;
  const savedSocket=(globalThis as any).WebSocket;
  (globalThis as any).window={location:{origin:'https://h00k.top'}};
  (globalThis as any).WebSocket=FakeClient;
  try {
    const connections:FakeClient[]=[];
    const bridge=createMultiplexBrowserLiquidations(url=>{
      const ws=new FakeClient(url);
      connections.push(ws);
      return ws as unknown as WebSocket;
    });
    const received: Record<string, number>={BTC:0,ETH:0};
    const statuses:boolean[]=[];
    const a=bridge.subscribe({
      exchange:'binance',symbol:'BTCUSDT',
      onSnapshot:rows=>{received.BTC+=rows.length;},
      onLiquidation:()=>{received.BTC++;},
      onStatus:x=>statuses.push(x),
    });
    const b=bridge.subscribe({
      exchange:'bybit',symbol:'ETHUSDT',
      onSnapshot:rows=>{received.ETH+=rows.length;},
      onLiquidation:()=>{received.ETH++;},
      onStatus:()=>{},
    });
    assert.equal(connections.length,1);
    assert.equal(bridge.activeScopes(),2);
    const ws=connections[0];
    assert.match(ws.url,/\/api\/hookchart\/liquidations-multi$/);
    ws.open();
    assert.equal(ws.sent.length,2);
    assert.deepEqual(ws.sent.map(x=>x.symbol),['BTCUSDT','ETHUSDT']);
    const event={id:'e1',side:'LONG',t:Date.now(),p:70000,q:2,usd:140000};
    ws.deliver({type:'snapshot',exchange:'binance',symbol:'BTCUSDT',events:[event],connected:true});
    ws.deliver({type:'snapshot',exchange:'bybit',symbol:'ETHUSDT',events:[],connected:true});
    ws.deliver({type:'liquidation',exchange:'bybit',symbol:'ETHUSDT',event});
    ws.deliver({type:'liquidation',exchange:'binance',symbol:'DOGEUSDT',event});
    assert.deepEqual(received,{BTC:1,ETH:1});
    assert.deepEqual(statuses,[false]);
    a();
    assert.equal(ws.sent.at(-1)?.type,'unsubscribe');
    assert.equal(connections.length,1);
    b();
    assert.equal(bridge.activeScopes(),0);
    assert.equal(ws.readyState,3);
  } finally {
    (globalThis as any).window=savedWindow;
    (globalThis as any).WebSocket=savedSocket;
  }
});
