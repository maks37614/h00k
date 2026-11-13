import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marketTradeReconnectDelay } from '../src/components/hookchart/marketTradeStream';

test('public-trade reconnect uses bounded exponential backoff with per-browser jitter', () => {
  assert.equal(marketTradeReconnectDelay(0, 0), 1000);
  assert.equal(marketTradeReconnectDelay(0, 0.999), 1999);
  assert.equal(marketTradeReconnectDelay(1, 0), 2000);
  assert.equal(marketTradeReconnectDelay(2, 0.5), 4500);
  assert.equal(marketTradeReconnectDelay(4, 0), 16000);
  assert.equal(marketTradeReconnectDelay(90, 0.5), 16500);
  assert.equal(marketTradeReconnectDelay(-10, -1), 1000);
  assert.equal(marketTradeReconnectDelay(Number.NaN, Number.NaN), 1000);
  assert.ok(marketTradeReconnectDelay(9999, 1) <= 17000);
});

test('shared trade WebSocket uses jitter for both close and constructor failures', () => {
  const source = readFileSync(new URL('../src/components/hookchart/marketTradeStream.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/marketTradeReconnectDelay\(this\.retries\+\+\)/g) || []).length, 2);
  assert.match(source, /try \{\s*ws\.send\(JSON\.stringify\(\{ op: 'subscribe'/);
  assert.match(source, /A failed subscription is not a healthy open market feed/);
  assert.match(source, /catch \{ try \{ ws\.close\(\); \} catch \{\} reconnect\(\); \}/);
  assert.match(source, /this\.reconnectTimer = setTimeout/);
});
