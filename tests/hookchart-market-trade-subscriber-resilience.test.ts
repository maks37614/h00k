import test from 'node:test';
import assert from 'node:assert/strict';
import { getSharedMarketPrints, subscribeMarketTrades } from '../src/components/hookchart/marketTradeStream';

type FakeMessage = { data: string };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  onmessage: ((event: FakeMessage) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(_payload: string) {}
  close() { this.readyState = 3; this.onclose?.(); }
  emit(tradeId: number, t = Date.now()) {
    this.onmessage?.({ data: JSON.stringify({ T: t, p: '100', q: '10', m: false, a: tradeId }) });
  }
}

const scope = { exchange: 'binance' as const, marketType: 'futures' as const, symbol: 'BTCUSDT' };
const listener = () => ({ onTrade: () => {}, onPrints: () => {} });
const nextTick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function mockMarketNetwork() {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.fetch = async () => Response.json([]);
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  return () => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  };
}

test('throwing trade/print listeners never interrupt other charts sharing one market stream', async () => {
  const restore = mockMarketNetwork();
  const stop: Array<() => void> = [];
  try {
    stop.push(subscribeMarketTrades(scope, {
      onTrade: () => { throw new Error('bad chart trade handler'); },
      onPrints: () => { throw new Error('bad chart print handler'); },
      wantsPrints: () => true,
    }));
    stop.push(subscribeMarketTrades(scope, {
      onTrade: () => { throw new Error('bad chart trade handler'); },
      onPrints: () => {},
      wantsPrints: () => { throw new Error('bad chart preference handler'); },
    }));
    const trades: string[] = [];
    const prints: number[] = [];
    stop.push(subscribeMarketTrades(scope, {
      onTrade: trade => { trades.push(trade.id); },
      onPrints: rows => { prints.push(rows.length); },
      wantsPrints: () => true,
    }));

    await nextTick();
    assert.equal(FakeWebSocket.instances.length, 1, 'one socket per exchange/market/symbol');
    const ws = FakeWebSocket.instances[0];
    const now = Date.now();
    ws.emit(70001, now);
    ws.emit(70002, now + 10);
    assert.deepEqual(trades, ['70001', '70002']);
    assert.ok(getSharedMarketPrints(scope).length > 0, 'shared trade tracker must still accumulate volume');

    await new Promise(resolve => setTimeout(resolve, 560));
    assert.ok(prints.some(value => value > 0), 'healthy print listeners must receive buffered updates');

    // Joining a busy stream replays existing trades and current prints.
    // A callback failure must not abort subscribe or leak an unremovable listener.
    let newStop: (() => void) | undefined;
    assert.doesNotThrow(() => {
      newStop = subscribeMarketTrades(scope, {
        onTrade: () => { throw new Error('bad history replay'); },
        onPrints: () => { throw new Error('bad snapshot'); },
        wantsPrints: () => true,
      });
    });
    if (newStop) stop.push(newStop);
    ws.emit(70003, now + 20);
    assert.deepEqual(trades, ['70001', '70002', '70003']);
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    for (const unsubscribe of stop.reverse()) unsubscribe();
    restore();
  }
});

test('repeating an obsolete disposer never removes the replacement stream for another chart', async () => {
  const restore = mockMarketNetwork();
  const stop: Array<() => void> = [];
  try {
    const old = subscribeMarketTrades(scope, listener());
    stop.push(old);
    await nextTick();
    assert.equal(FakeWebSocket.instances.length, 1);
    old(); // destroys the old stream

    const current = subscribeMarketTrades(scope, listener());
    stop.push(current);
    await nextTick();
    assert.equal(FakeWebSocket.instances.length, 2);
    old(); // stale cleanup from the earlier mount must be idempotent

    const more = subscribeMarketTrades(scope, listener());
    stop.push(more);
    await nextTick();
    assert.equal(FakeWebSocket.instances.length, 2, 'new cards still join the active replacement stream');
    assert.equal(FakeWebSocket.instances[1].readyState, 1);
  } finally {
    for (const unsubscribe of stop.reverse()) unsubscribe();
    restore();
  }
});
