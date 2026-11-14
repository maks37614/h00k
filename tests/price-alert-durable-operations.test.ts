import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AlertHistoryItem } from '../src/types';

test('price alerts remain unchanged when an atomic rename fails; retry is safe', async () => {
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
    const filename = path.join(dir, 'server', 'data', 'alerts.json');
    const before = fs.readFileSync(filename, 'utf8');
    assert.equal(svc.getAllAlerts(owner).length, 1);

    fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
      if (String(target) === filename) throw new Error('simulated disk failure');
      return originalRename(source, target);
    }) as typeof fs.renameSync;
    assert.throws(() => svc.toggleAlert(data.id, owner, false), /Не вдалося зберегти/);
    assert.equal(svc.getAllAlerts(owner)[0].isActive, true);
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
    assert.throws(() => svc.createAlert({ ...data, id: 'alert-test-2' }), /Не вдалося зберегти/);
    assert.equal(svc.getAllAlerts(owner).length, 1);
    assert.throws(() => svc.createAlertsBatch(owner, [{ ...data, id: 'batch-1' }]),
      /Не вдалося зберегти/);
    assert.equal(svc.getAllAlerts(owner).length, 1);
    assert.equal(fs.readFileSync(filename, 'utf8'), before);

    fs.renameSync = originalRename;
    const turnedOff = svc.toggleAlert(data.id, owner, false);
    assert.equal(turnedOff?.isActive, false);
    assert.equal(svc.getAllAlerts(owner)[0].isActive, false);
    assert.notEqual(fs.readFileSync(filename, 'utf8'), before);
  } finally {
    fs.renameSync = originalRename;
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('alert deletion survives partial disk failure via durable tombstone', async () => {
  // Separate test process from the previous dynamic import, so cwd and caches
  // must be shared only within this file.
  const svc = await import('../server/alertService');
  const owner = 'user-test-alert-1';
  const id = 'tombstone-alert-1';
  const alert = svc.createAlert({ id, userId: owner, symbol: 'ETHUSDT',
    exchange: 'binance', marketType: 'futures', targetPrice: 3500, condition: 'gte' });
  assert.equal(alert.id, id);
  const alertFile = path.join(process.cwd(), 'server', 'data', 'alerts.json');
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
      if (String(target) === alertFile) throw new Error('simulated second rename failure');
      return originalRename(source, target);
    }) as typeof fs.renameSync;
    assert.equal(svc.deleteAlert(id, owner), true);
    assert.equal(svc.getAllAlerts(owner).some(item => item.id === id), false);
    assert.throws(() => svc.createAlert({ id, userId: owner, symbol: 'ETHUSDT',
      exchange: 'binance', marketType: 'futures', targetPrice: 3500, condition: 'gte' }),
      /Сповіщення вже видалено/);
    const tombstones = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server', 'data', 'deleted_alerts.json'), 'utf8'));
    assert.ok(tombstones.includes(owner + ':' + id));
  } finally {
    fs.renameSync = originalRename;
  }
});

test('alert history does not acknowledge an undurable event', async () => {
  const svc = await import('../server/alertService');
  const historyFile = path.join(process.cwd(), 'server', 'data', 'alert_history.json');
  const originalRename = fs.renameSync;
  const item: AlertHistoryItem = {
    id: 'hist-test', userId: 'user-test-alert-1', alertId: 'alert-test-1',
    symbol: 'BTCUSDT', exchange: 'binance', marketType: 'futures',
    targetPrice: 90000, triggeredPrice: 90100, condition: 'gte',
    triggeredAt: 1794618000000, telegramSent: false,
  };
  try {
    fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
      if (String(target) === historyFile) throw new Error('simulated history rename failure');
      return originalRename(source, target);
    }) as typeof fs.renameSync;
    assert.throws(() => svc.addHistoryItem(item), /Не вдалося зберегти історію/);
    assert.equal(svc.getAlertHistory(item.userId).some(row => row.id === item.id), false);
    fs.renameSync = originalRename;
    svc.addHistoryItem(item);
    assert.equal(svc.getAlertHistory(item.userId).some(row => row.id === item.id), true);
  } finally {
    fs.renameSync = originalRename;
  }
});
