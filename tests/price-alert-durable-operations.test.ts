import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AlertHistoryItem } from '../src/types';

test('price alert edits, deletion and history survive simulated disk failures', async () => {
  // The service resolves server/data at import time. Keep all cases within
  // this isolated, temporary working directory and one test process.
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h00k-price-alerts-durable-'));
  const originalRename = fs.renameSync;
  process.chdir(dir);
  try {
    const svc = await import('../server/alertService');
    const owner = 'user-test-alert-1';
    const data = { id: 'alert-test-1', userId: owner, symbol: 'BTCUSDT',
      exchange: 'binance' as const, marketType: 'futures' as const,
      targetPrice: 90000, condition: 'gte' as const };
    const initial = svc.createAlert(data);
    assert.equal(initial.isActive, true);
    const alertFile = path.join(dir, 'server', 'data', 'alerts.json');
    const historyFile = path.join(dir, 'server', 'data', 'alert_history.json');
    const deletedFile = path.join(dir, 'server', 'data', 'deleted_alerts.json');
    const before = fs.readFileSync(alertFile, 'utf8');
    assert.equal(svc.getAllAlerts(owner).length, 1);

    const blockRename = (targetFile: string) => {
      const failingRename: typeof fs.renameSync = (source, target) => {
        if (String(target) === targetFile) throw new Error('simulated disk failure');
        originalRename(source, target);
      };
      fs.renameSync = failingRename;
    };

    // A failed update, creation or batch creation changes neither memory
    // nor the persisted source of truth.
    blockRename(alertFile);
    assert.throws(() => svc.toggleAlert(data.id, owner, false), /Не вдалося зберегти/);
    assert.equal(svc.getAllAlerts(owner)[0].isActive, true);
    assert.throws(() => svc.createAlert({ ...data, id: 'alert-test-2' }), /Не вдалося зберегти/);
    assert.throws(() => svc.createAlertsBatch(owner, [{ ...data, id: 'batch-1' }]),
      /Не вдалося зберегти/);
    assert.equal(svc.getAllAlerts(owner).length, 1);
    assert.equal(fs.readFileSync(alertFile, 'utf8'), before);

    fs.renameSync = originalRename;
    assert.equal(svc.toggleAlert(data.id, owner, false)?.isActive, false);
    assert.equal(svc.getAllAlerts(owner)[0].isActive, false);

    // History writes are transactional from the application's point of view.
    const item: AlertHistoryItem = {
      id: 'hist-test', userId: owner, alertId: data.id,
      symbol: 'BTCUSDT', exchange: 'binance', marketType: 'futures',
      targetPrice: 90000, triggeredPrice: 90100, condition: 'gte',
      triggeredAt: 1794618000000, telegramSent: false,
    };
    blockRename(historyFile);
    assert.throws(() => svc.addHistoryItem(item), /Не вдалося зберегти історію/);
    assert.equal(svc.getAlertHistory(owner).some(row => row.id === item.id), false);
    fs.renameSync = originalRename;
    svc.addHistoryItem(item);
    assert.equal(svc.getAlertHistory(owner).some(row => row.id === item.id), true);

    // Deletions are safe even if the second (alerts.json) file write fails:
    // tombstones keep stale browser syncs from resurrecting deleted alerts.
    const deletedId = 'tombstone-alert-1';
    svc.createAlert({ ...data, id: deletedId });
    blockRename(alertFile);
    assert.equal(svc.deleteAlert(deletedId, owner), true);
    assert.equal(svc.getAllAlerts(owner).some(row => row.id === deletedId), false);
    assert.throws(() => svc.createAlert({ ...data, id: deletedId }), /Сповіщення вже видалено/);
    const tombstones = JSON.parse(fs.readFileSync(deletedFile, 'utf8'));
    assert.ok(tombstones.includes(owner + ':' + deletedId));

    // If writing the tombstone itself fails, the operation must not appear
    // committed; the old alert remains live and can be retried.
    fs.renameSync = originalRename;
    const retryId = 'retry-deletion-alert';
    svc.createAlert({ ...data, id: retryId });
    blockRename(deletedFile);
    assert.throws(() => svc.deleteAlert(retryId, owner), /simulated disk failure/);
    assert.equal(svc.getAllAlerts(owner).some(row => row.id === retryId), true);
    fs.renameSync = originalRename;
    assert.equal(svc.deleteAlert(retryId, owner), true);
    assert.equal(svc.getAllAlerts(owner).some(row => row.id === retryId), false);
  } finally {
    fs.renameSync = originalRename;
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
