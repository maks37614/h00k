import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getUserTelegram } from './userTelegram';
import { sendTelegramMessage, editTelegramMessage } from './telegramService';
import { telegramDispatchQueue } from './telegramQueue';
import { formatTelegramMessages } from './telegramFormat';

export interface TelegramDelivery {
  id: string;
  userId: string;
  eventKey?: string;
  text: string;
  botId: string;
  chatId: string;
  messageIds: number[];
  status: 'pending' | 'sent' | 'failed';
  createdAt: number;
  sentAt?: number;
  attempts: number;
  nextAttemptAt: number;
  error?: string;
}

let deliveries: TelegramDelivery[] | undefined;
let recordsById = new Map<string, TelegramDelivery>();
let lastByEvent = new Map<string, number>();
let retryTimer: ReturnType<typeof setInterval> | undefined;
const inFlight = new Map<string, Promise<DeliveryResult>>();
interface DeliveryResult { success: boolean; queued?: boolean; error?: string; deliveryId?: string; messageIds?: number[] }
const filePath = path.join(process.cwd(), 'server/data/telegram_messages.json');

function indexRecords(records: TelegramDelivery[]) {
  recordsById = new Map(records.map(item => [item.id, item]));
  lastByEvent = new Map();
  for (const item of records) if (item.eventKey && item.status !== 'failed') {
    const key = JSON.stringify([item.userId, item.eventKey]);
    lastByEvent.set(key, Math.max(lastByEvent.get(key) || 0, item.sentAt || item.createdAt));
  }
}

function load(): TelegramDelivery[] {
  if (!deliveries) {
    const stored = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];
    if (!Array.isArray(stored)) throw new Error('Invalid Telegram delivery history');
    deliveries = stored;
    indexRecords(stored);
  }
  return deliveries!;
}

function persist() {
  const file = filePath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Pending records are never discarded by history retention.
  const retained = new Map<string, number>();
  deliveries = [...load()].reverse().filter(item => {
    if (item.status === 'pending') return true;
    const count = retained.get(item.userId) || 0;
    retained.set(item.userId, count + 1);
    return count < 500;
  }).reverse();
  indexRecords(deliveries);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(deliveries), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export function getTelegramDelivery(userId: string, id: string): TelegramDelivery | undefined {
  load();
  const record = recordsById.get(id);
  return record?.userId === userId ? { ...record, messageIds: [...record.messageIds] } : undefined;
}

export function lastTelegramDeliveryAt(userId: string, eventKey: string): number {
  load();
  return lastByEvent.get(JSON.stringify([userId, eventKey])) || 0;
}

export function recordSentTelegramMessage(userId: string, text: string, messageIds: number[]): void {
  const target = getUserTelegram(userId);
  if (!target?.botToken || !target.chatId || !messageIds.length) return;
  load().push({
    id: randomUUID(), userId, text, botId: target.botToken.split(':')[0], chatId: target.chatId,
    messageIds: [...messageIds], status: 'sent', createdAt: Date.now(), sentAt: Date.now(), attempts: 1, nextAttemptAt: 0,
  });
  persist();
}

async function deliver(record: TelegramDelivery): Promise<DeliveryResult> {
  const existing = inFlight.get(record.id);
  if (existing) return existing;
  const task = (async (): Promise<DeliveryResult> => {
    const target = getUserTelegram(record.userId);
    // Do not combine a saved old bot/chat with a newly changed destination.
    if (!target?.confirmedAt || !target.botToken || !target.chatId || target.botToken.split(':')[0] !== record.botId || target.chatId !== record.chatId) {
      record.status = 'failed';
      record.error = 'Telegram відключено або одержувач змінився. Старе повідомлення не перенаправлено.';
    } else {
      record.attempts++;
      const result = await telegramDispatchQueue.schedule(record.botId, record.chatId,
        () => sendTelegramMessage(record.text, {
          botToken: target.botToken, chatId: target.chatId, startPart: record.messageIds.length,
        }));
      record.messageIds.push(...result.messageIds);
      if (result.success) {
        record.status = 'sent';
        record.sentAt = Date.now();
        record.error = undefined;
      } else {
        record.error = result.error;
        record.status = result.retryable && record.attempts < 8 && Date.now() - record.createdAt < 24 * 3600 * 1000 ? 'pending' : 'failed';
        record.nextAttemptAt = Date.now() + Math.max(result.retryAfterSeconds || 0, Math.min(900, 5 * 2 ** record.attempts)) * 1000;
      }
    }
    persist();
    return { success: record.status === 'sent', queued: record.status === 'pending', error: record.error, deliveryId: record.id, messageIds: [...record.messageIds] };
  })().finally(() => { inFlight.delete(record.id); });
  inFlight.set(record.id, task);
  return task;
}

export async function sendUserTelegramMessage(userId: string, text: string, eventKey?: string): Promise<DeliveryResult> {
  const target = getUserTelegram(userId);
  if (target?.needsConfirmation) return { success: false, error: 'Підключіть ваш Telegram до спільного бота у профілі.' };
  if (!target?.botToken || !target.chatId) return { success: false, error: 'Сповіщення Telegram не підключені. Підключіть свій чат у профілі.' };
  if (!target.confirmedAt) return { success: false, error: 'Підтвердіть особисте підключення Telegram у своєму профілі після оновлення.' };
  // An event key is unique for one user's one notification cycle. A message
  // acknowledged by Telegram must never be sent again after a stale sync,
  // process restart, or concurrent retry. Only explicit rearming changes it.
  const previous = eventKey ? load().find(item => item.userId === userId && item.eventKey === eventKey) : undefined;
  if (previous) {
    return {
      success: previous.status === 'sent',
      queued: previous.status === 'pending',
      error: previous.error,
      deliveryId: previous.id,
      messageIds: [...previous.messageIds],
    };
  }
  const record: TelegramDelivery = {
    id: randomUUID(), userId, eventKey, text,
    botId: target.botToken.split(':')[0], chatId: target.chatId,
    messageIds: [], status: 'pending', createdAt: Date.now(), attempts: 0, nextAttemptAt: Date.now(),
  };
  if (load().filter(item => item.status === 'pending').length >= 5000) return { success: false, error: 'Черга Telegram переповнена. Повторіть пізніше.' };
  load().push(record);
  persist();
  return deliver(record);
}

let retryFlight: Promise<void> | undefined;
export async function retryPendingTelegramMessages(): Promise<void> {
  if (retryFlight) return retryFlight;
  retryFlight = (async () => {
    const due = load().filter(item => item.status === 'pending' && item.nextAttemptAt <= Date.now()).slice(0, 20);
    for (const record of due) await deliver(record);
  })().finally(() => { retryFlight = undefined; });
  return retryFlight;
}

export function startTelegramDeliveryWorker() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    retryPendingTelegramMessages().catch(() => console.error('[Telegram] Could not process the delivery queue'));
  }, 5000);
  retryTimer.unref();
}

/** Edit only messages whose Telegram IDs and owner were recorded on this server. */
export async function reformatUserTelegramMessages(userId: string) {
  const target = getUserTelegram(userId);
  if (!target?.confirmedAt || !target.botToken || !target.chatId) throw new Error('Спочатку підтвердьте підключення вашого Telegram');
  let edited = 0, skipped = 0, failed = 0;
  for (const record of load().filter(item => item.userId === userId && item.status === 'sent')) {
    const parts = formatTelegramMessages(record.text);
    if (record.botId !== target.botToken.split(':')[0] || record.chatId !== target.chatId || !record.messageIds.length || parts.length !== record.messageIds.length) { skipped++; continue; }
    let success = true;
    for (let index = 0; index < parts.length; index++) {
      const result = await editTelegramMessage(record.messageIds[index], parts[index], { botToken: target.botToken, chatId: record.chatId });
      if (!result.success) { success = false; break; }
    }
    if (success) edited++; else failed++;
  }
  return { success: failed === 0, edited, skipped, failed };
}
