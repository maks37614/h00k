import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Telegram queue rejects malformed pending records and keeps processing after one retry write fails', async () => {
  const previousCwd = process.cwd();
  const previousBot = process.env.TELEGRAM_BOT_TOKEN;
  const previousFetch = globalThis.fetch;
  const originalRename = fs.renameSync;
  const originalWrite = fs.writeFileSync;
  const originalChmod = fs.chmodSync;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'h00k-telegram-retry-isolation-'));
  process.chdir(temp);
  process.env.TELEGRAM_BOT_TOKEN = '999:queue-fixture';
  const file = path.join(temp, 'server/data/telegram_messages.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const first = {
      id: 'delivery-one', userId: 'queue-owner', eventKey: 'event-one',
      text: 'First delivery', botId: '999', chatId: '31415', messageIds: [],
      status: 'pending', createdAt: Date.now() - 5000, attempts: 0, nextAttemptAt: 0,
    };
    const second = { ...first, id: 'delivery-two', eventKey: 'event-two', text: 'Second delivery' };
    const delivery = await import('../server/telegramDelivery');
    const users = await import('../server/userTelegram');
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return Response.json({
        ok: true, result: { message_id: 1000 + requests, chat: { id: 31415 } },
      });
    };

    const malformed: unknown[][] = [
      [{ ...first, nextAttemptAt: undefined }],
      [{ ...first, nextAttemptAt: 'tomorrow' }],
      [{ ...first, attempts: -1 }],
      [{ ...first, messageIds: ['invalid'] }],
      [{ ...first, botId: undefined }],
      [{ ...first, createdAt: 'not-a-date' }],
      [first, { ...first }],
    ];
    for (const items of malformed) {
      const raw = JSON.stringify(items);
      fs.writeFileSync(file, raw);
      await assert.rejects(delivery.retryPendingTelegramMessages(), /Invalid Telegram delivery history/);
      assert.equal(fs.readFileSync(file, 'utf8'), raw,
        'corrupt queue must not be rewritten as an empty history');
      assert.equal(requests, 0, 'invalid pending records must never be dispatched');
    }

    users.connectUserTelegram('queue-owner', '999', '31415');
    fs.writeFileSync(file, JSON.stringify([first, second]));
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(`${file}.tmp`, 'leftover world-readable temp file');
    fs.chmodSync(`${file}.tmp`, 0o644);

    let checkedPrivateBeforeWrite = 0;
    let failedFirstAck = false;
    fs.writeFileSync = ((target: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (String(target) === `${file}.tmp`) {
        checkedPrivateBeforeWrite++;
        assert.equal(fs.statSync(String(target)).mode & 0o777, 0o600,
          'old temp files must be restricted before writing private messages');
      }
      return (originalWrite as any)(target, ...args);
    }) as typeof fs.writeFileSync;
    fs.renameSync = ((from, to) => {
      if (String(to) === file && !failedFirstAck) {
        failedFirstAck = true;
        throw new Error('simulated acknowledgment write failure');
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync;

    await delivery.retryPendingTelegramMessages();
    assert.equal(failedFirstAck, true);
    assert.equal(requests, 2, 'one storage error must not block the next pending recipient');
    assert.ok(checkedPrivateBeforeWrite >= 2);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600,
      'the queue itself is restricted on first load and subsequent writes');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved[0].status, 'pending', 'failed acknowledgment stays retryable');
    assert.equal(saved[1].status, 'sent', 'independent notification is durably acknowledged');
    assert.equal(saved[1].messageIds[0], 1002);

    fs.renameSync = originalRename;
    fs.writeFileSync = originalWrite;
    const before = fs.readFileSync(file, 'utf8');
    fs.chmodSync = ((target, mode) => {
      if (String(target) === `${file}.tmp`) throw new Error('permission change rejected');
      return originalChmod(target, mode);
    }) as typeof fs.chmodSync;
    await assert.rejects(
      delivery.sendUserTelegramMessage('queue-owner', 'Not durably queued', 'blocked-by-permission'),
      /permission change rejected/,
    );
    assert.equal(requests, 2, 'failed chmod must prevent any network request');
    assert.equal(fs.readFileSync(file, 'utf8'), before,
      'permission failure must preserve the last durable snapshot');
    assert.equal(delivery.lastTelegramDeliveryAt('queue-owner', 'blocked-by-permission'), 0);
  } finally {
    fs.renameSync = originalRename;
    fs.writeFileSync = originalWrite;
    fs.chmodSync = originalChmod;
    globalThis.fetch = previousFetch;
    if (previousBot === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousBot;
    process.chdir(previousCwd);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
