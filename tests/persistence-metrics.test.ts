import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PersistenceMetrics } from '../server/persistenceMetrics';

test('operator persistence counters expose durations and sizes, never private records', () => {
  const metrics = new PersistenceMetrics();
  metrics.record('alerts', 8, 1200, true);
  metrics.record('alerts', 12, 350, false);
  metrics.record('surveillance', 100, 64000, true);
  const rows = metrics.stats();
  assert.deepEqual(rows.alerts, {
    writes: 2, failures: 1, avgDurationMs: 10,
    maxDurationMs: 12, lastDurationMs: 12, totalBytes: 1200, lastBytes: 350,
  });
  assert.equal(rows.surveillance.maxDurationMs, 100);
  assert.equal(rows.alertHistory.writes, 0);
  assert.ok(!JSON.stringify(rows).includes('userId'));
});

test('durable alert history writes a temp file before an atomic rename', () => {
  const source = readFileSync(new URL('../server/alertService.ts', import.meta.url), 'utf8');
  const history = source.slice(source.indexOf('export function saveHistory('),
    source.indexOf('/** Completed alert cycles'));
  assert.match(history, /protectExistingAlertTemp\(temp\)/);
  assert.match(history, /fs\.writeFileSync\(temp, payload, \{ encoding: 'utf-8', mode: 0o600 \}\)/);
  assert.match(history, /fs\.chmodSync\(temp, 0o600\)/);
  assert.ok(history.indexOf('protectExistingAlertTemp(temp)') < history.indexOf('fs.writeFileSync(temp, payload'),
    'a stale temp file must be made private before any personal history data is written');
  assert.match(history, /fs\.renameSync\(temp, HISTORY_FILE\)/);
  assert.ok(history.indexOf('fs.renameSync') < history.indexOf('historyCache = items'),
    'memory must not claim the alert has been persisted before rename succeeds');
  const operator = readFileSync(new URL('../server/opsMetrics.ts', import.meta.url), 'utf8');
  assert.match(operator, /persistence: persistenceMetrics\.stats\(\)/);
});
