import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import WebSocket from 'ws';
import { installLiquidationStream, liquidationFeed, liquidationUpstreamUrl, parseLiquidations } from '../server/liquidationFeed';

test('Binance forced-order snapshot calculates real observed USD and position side', () => {
  const now = Date.now();
  const rows = parseLiquidations('binance', 'BTCUSDT', {
    e: 'forceOrder', E: now,
    o: { s: 'BTCUSDT', i: 42, S: 'SELL', T: now, ap: '75000', z: '2', l: '2', q: '2' },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usd, 150_000);
  assert.equal(rows[0].side, 'LONG');
  assert.equal(rows[0].id, 'bin:BTCUSDT:42');
});

test('Bybit allLiquidation preserves multiple events per update', () => {
  const now = Date.now();
  const rows = parseLiquidations('bybit', 'ETHUSDT', {
    topic: 'allLiquidation.ETHUSDT',
    data: [
      { T: now, S: 'Buy', p: '3500', v: '3' },
      { T: now, S: 'Sell', p: '3490', v: '4' },
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.side), ['LONG', 'SHORT']);
  assert.deepEqual(rows.map(row => row.usd), [10500, 13960]);
});

test('Rejects stale, nonfinite and other-symbol liquidation events', () => {
  const now = Date.now();
  assert.equal(parseLiquidations('binance', 'BTCUSDT', {
    o: { s: 'ETHUSDT', T: now, ap: '3000', q: '1', S: 'SELL' },
  }).length, 0);
  assert.equal(parseLiquidations('binance', 'BTCUSDT', {
    o: { s: 'BTCUSDT', T: now - 31 * 60_000, ap: '70000', q: '1', S: 'SELL' },
  }).length, 0);
  assert.equal(parseLiquidations('bybit', 'BTCUSDT', {
    topic: 'allLiquidation.BTCUSDT', data: [{ T: now, p: '0', v: '1', S: 'Buy' }],
  }).length, 0);
});

test('Bybit packet row reordering does not create new IDs', () => {
  const now = Date.now();
  const a = { T: now, S: 'Buy', p: '100.00', v: '2.0' };
  const b = { T: now, S: 'Sell', p: '101', v: '3' };
  const packet = { topic: 'allLiquidation.BTCUSDT', ts: now };
  const first = parseLiquidations('bybit', 'BTCUSDT', { ...packet, data: [a, b, a] });
  const reordered = parseLiquidations('bybit', 'BTCUSDT', { ...packet, data: [b, a, a] });
  assert.deepEqual(first.map(row => row.id).sort(), reordered.map(row => row.id).sort());
});

test('liquidation WebSocket accepts Unicode contracts and rejects malformed symbols', async t => {
  const received: Array<{ symbol: string; liveOnly: boolean }> = [];
  t.mock.method(liquidationFeed, 'startPersistence', () => {});
  t.mock.method(liquidationFeed, 'addClient', (client: WebSocket, _exchange: string, symbol: string, liveOnly = false) => {
    received.push({ symbol, liveOnly });
    client.close(1000);
  });
  const server = http.createServer();
  installLiquidationStream(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  for (const [symbol, expected] of [['龙虾USDT', 1000], ['E\u0301USDT', 1000], ['BTCUSDT', 1000], ['BTC/USDT', 1008], ['A'.repeat(81), 1008]] as const) {
    const code = await new Promise<number>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/api/hookchart/liquidations?exchange=binance&symbol=${encodeURIComponent(symbol)}${symbol === 'BTCUSDT' ? '&live=1' : ''}`);
      client.on('close', resolve);
      client.on('error', reject);
    });
    assert.equal(code, expected, symbol);
  }
  assert.deepEqual(received, [{ symbol: '龙虾USDT', liveOnly: false },
    { symbol: 'E\u0301USDT', liveOnly: false }, { symbol: 'BTCUSDT', liveOnly: true }]);
  const url = new URL(liquidationUpstreamUrl('binance', '龙虾USDT'));
  assert.equal(url.hostname, 'fstream.binance.com');
  assert.equal(decodeURIComponent(url.pathname), '/market/ws/龙虾usdt@forceOrder');
});
