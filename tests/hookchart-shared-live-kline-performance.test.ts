import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createSharedKlineSubscriptions, parseSharedKlineMessage } from '../src/components/hookchart/sharedKlineStream';
import { toHookCandles } from '../src/utils/hookchartData';

class FakeSocket {
  static OPEN = 1;
  readonly sent: string[] = [];
  readyState = 1;
  closed = 0;
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(data); }
  close() { this.closed++; this.readyState = 3; }
  emit(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

const kline = (time: number, price: number, volume: number) => ({
  time, open: price, high: price + 2, low: price - 2, close: price + 1, volume,
});

test('120 live same-market HookCharts share one kline WebSocket', () => {
  const sockets: FakeSocket[] = [];
  const manager = createSharedKlineSubscriptions(url => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const scope = { exchange: 'binance' as const, marketType: 'futures' as const,
    symbol: 'BTCUSDT', timeframe: '1m' };
  const received: number[][] = Array.from({ length: 120 }, () => []);
  const stops = received.map(rows => manager.subscribe(scope, {
    onCandle: row => rows.push(row.volume),
    onStatus: () => {},
  }));
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /btcusdt@kline_1m$/);
  sockets[0].onopen?.({});
  sockets[0].emit({ e: 'kline', s: 'BTCUSDT', E: 1710000000100, k: {
    t: 1710000000000, i: '1m', o: '100', h: '102', l: '99', c: '101', v: '42', n: 3,
  } });
  for (const rows of received) assert.deepEqual(rows, [42]);
  stops.slice(0, 119).forEach(stop => stop());
  assert.equal(sockets[0].closed, 0);
  stops[119]();
  assert.equal(sockets[0].closed, 1);
  assert.equal(manager.activeScopes(), 0);
});

test('different timeframes and exchange scopes never share their candles', () => {
  const sockets: FakeSocket[] = [];
  const manager = createSharedKlineSubscriptions(url => {
    const socket = new FakeSocket(url); sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const scope = { exchange: 'binance' as const, marketType: 'futures' as const,
    symbol: 'BTCUSDT', timeframe: '1m' };
  const listener = { onCandle: () => {}, onStatus: () => {} };
  const stops = [
    manager.subscribe(scope, listener),
    manager.subscribe({ ...scope, timeframe: '5m' }, listener),
    manager.subscribe({ ...scope, symbol: 'ETHUSDT' }, listener),
    manager.subscribe({ ...scope, exchange: 'bybit' }, listener),
  ];
  assert.equal(sockets.length, 4);
  assert.equal(manager.activeScopes(), 4);
  const bybit = sockets[3];
  bybit.onopen?.({});
  assert.match(bybit.sent.join(''), /kline\.1\.BTCUSDT/);
  stops.forEach(stop => stop());
  assert.equal(manager.activeScopes(), 0);
  assert.equal(bybit.closed, 1);
});

test('late subscribers get only latest candle, stale or malformed messages ignored', () => {
  let socket: FakeSocket | undefined;
  const manager = createSharedKlineSubscriptions(url => {
    socket = new FakeSocket(url); return socket as unknown as WebSocket;
  });
  const scope = { exchange: 'binance' as const, marketType: 'spot' as const,
    symbol: 'SOLUSDT', timeframe: '5m' };
  const values: number[] = [], late: number[] = [];
  const stop1 = manager.subscribe(scope, { onCandle: c => values.push(c.time) });
  socket!.emit({ e: 'kline', s: 'SOLUSDT', E: 1720000000000,
    k: { t: 1720000000000, i: '5m', o: '100', h: '102', l: '99', c: '101', v: '10' } });
  socket!.emit({ e: 'kline', s: 'SOLUSDT', E: 1719999999000,
    k: { t: 1719999990000, i: '5m', o: '100', h: '102', l: '99', c: '101', v: '10' } });
  const stop2 = manager.subscribe(scope, { onCandle: c => late.push(c.time) });
  assert.equal(values.length, 1);
  assert.deepEqual(late, values);
  assert.equal(parseSharedKlineMessage('binance', { e: 'aggTrade' }, 'SOLUSDT', '5m'), null);
  assert.equal(parseSharedKlineMessage('binance', { e: 'kline', s: 'OTHERUSDT', k: {} }, 'SOLUSDT', '5m'), null);
  stop1(); stop2();
});

test('historical Replay does not subscribe to a live-market feed', () => {
  const replay = readFileSync(new URL('../src/components/replay/ReplayChart.tsx', import.meta.url), 'utf8');
  const hook = readFileSync(new URL('../src/components/hookchart/useOriginalHookChartLiveFeed.ts', import.meta.url), 'utf8');
  assert.match(replay, /<HookChart[^>]*klines=\{visibleCandles\}/);
  assert.match(replay, /markers=\{hookMarkers\} replay/);
  assert.doesNotMatch(replay, /subscribeSharedKlines|subscribeMarketTrades|fetchSharedLiveFallback/);
  assert.match(hook, /if \(replay \|\| !exchangeSymbol\)/);
  assert.match(hook, /if \(replay \|\| !exchangeSymbol \|\| marketType !== 'futures'\)/);
});

test('optimized candle conversion preserves duplicate and out-of-order replay semantics', () => {
  const original = [kline(10, 100, 10), kline(30, 105, 30),
    kline(20, 101, 20), kline(30, 108, 33)];
  const out = toHookCandles(original);
  assert.deepEqual(out.map(x => [x.t, x.v]), [[10000, 10], [20000, 20], [30000, 33]]);
  const ordered = toHookCandles([kline(10, 100, 10), kline(20, 101, 20), kline(20, 103, 29)]);
  assert.deepEqual(ordered.map(x => [x.t, x.v]), [[10000, 10], [20000, 29]]);
});
