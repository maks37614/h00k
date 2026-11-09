import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalLiquidationId,
  deduplicateLiquidations,
  filterVisibleLiquidations,
} from '../src/components/hookchart/liquidationDisplay';
import {
  getSessionLiquidationTotals,
  recordSessionLiquidation,
  sessionLiquidationScope,
} from '../src/components/hookchart/liquidationSession';

test('Long and Short liquidation thresholds are independent', () => {
  const rows = [
    { id: 'l1', side: 'LONG' as const, usd: 500 },
    { id: 's1', side: 'SHORT' as const, usd: 1500 },
    { id: 'l2', side: 'LONG' as const, usd: 2500 },
    { id: 's2', side: 'SHORT' as const, usd: 3000 },
  ];
  assert.deepEqual(
    filterVisibleLiquidations(rows, 1000, {
      liquidationLongMinUsd: 2000, liquidationShortMinUsd: 2000,
    }).map(row => row.id),
    ['l2', 's2'],
  );
  assert.deepEqual(filterVisibleLiquidations(rows, 1000, { showLiquidationLong: false }).map(row => row.id), ['s1', 's2']);
  assert.deepEqual(filterVisibleLiquidations(rows, 1000, { showLiquidationShort: false }).map(row => row.id), ['l2']);
  assert.deepEqual(
    filterVisibleLiquidations(rows, 0, {
      liquidationLongMinUsd: 0, liquidationShortMinUsd: 0,
    }).map(row => row.id),
    ['l1', 's1', 'l2', 's2'],
  );
  assert.deepEqual(filterVisibleLiquidations(rows, 0, {}), []);
  assert.equal(rows.length, 4);
});

test('Bybit duplicates in packet-index variants do not inflate candle labels', () => {
  const first = 'byb:BTCUSDT:1794258000000:Buy:100:2:0';
  const duplicated = 'byb:BTCUSDT:1794258000000:Buy:100:2:3';
  assert.equal(canonicalLiquidationId(first), canonicalLiquidationId(duplicated));
  assert.deepEqual(
    deduplicateLiquidations([
      { id: first, usd: 200 }, { id: duplicated, usd: 200 },
    ]).map(row => row.usd),
    [200],
  );
});

test('Session totals survive timeframe changes and do not mix coins or exchanges', () => {
  const binBtc = sessionLiquidationScope('Binance', 'futures', 'btcusdt');
  const bybBtc = sessionLiquidationScope('Bybit', 'futures', 'BTCUSDT');
  const binEth = sessionLiquidationScope('Binance', 'futures', 'ETHUSDT');
  const now = Date.now();
  const mk = (id: string, side: 'LONG' | 'SHORT', usd: number) => ({ id, side, usd, t: now });
  assert.equal(recordSessionLiquidation(binBtc, mk('bin-first', 'LONG', 1000)), true);
  assert.equal(recordSessionLiquidation(binBtc, mk('bin-first', 'LONG', 1000)), false);
  assert.equal(recordSessionLiquidation(binBtc, mk('bin-first', 'LONG', 1500)), true);
  assert.equal(recordSessionLiquidation(bybBtc, mk('byb-first', 'SHORT', 300)), true);
  assert.equal(recordSessionLiquidation(binEth, mk('bin-eth', 'LONG', 900)), true);
  assert.deepEqual(getSessionLiquidationTotals(binBtc), {
    totalUsd: 1500, longUsd: 1500, shortUsd: 0, count: 1,
  });
  assert.equal(getSessionLiquidationTotals(bybBtc).totalUsd, 300);
  assert.equal(getSessionLiquidationTotals(binEth).totalUsd, 900);
});

test('Old snapshots do not count as session events, but delayed live ticks do', () => {
  const scope = sessionLiquidationScope('Bybit', 'futures', 'SNAPTESTUSDT');
  const old = { id: 'old', side: 'LONG' as const, usd: 123, t: Date.now() - 90_000 };
  assert.equal(recordSessionLiquidation(scope, old, 'snapshot'), false);
  assert.equal(recordSessionLiquidation(scope, old, 'live'), true);
  assert.equal(recordSessionLiquidation(scope, old, 'live'), false);
  assert.equal(getSessionLiquidationTotals(scope).totalUsd, 123);
});
