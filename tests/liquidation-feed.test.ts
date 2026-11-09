import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLiquidations } from '../server/liquidationFeed';

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
