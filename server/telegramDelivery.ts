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
    let raw: string | null;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      // Only an actually missing file means a new empty delivery queue.
      // An inaccessible or damaged file must never be overwritten as empty.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      raw = null;
    }
    const stored: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(stored) || stored.some(item => !item ||
      typeof item !== 'object' || Array.isArray(item) ||
      typeof item.id !== 'string' || typeof item.userId !== 'string' ||
      !Array.isArray(item.messageIds) ||
      !['pending', 'sent', 'failed'].includes(item.status))) {
      throw new Error('Invalid Telegram delivery history');
    }
    deliveries = stored as TelegramDelivery[];
    indexRecords(deliveries);
  }
  return deliveries;
}

/** Write the next snapshot before publishing it to in-memory readers.
 * A failed rename cannot claim a notification was queued, sent or failed. */
function commitRecords(records: TelegramDelivery[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Pending records are never discarded by history retention.
  const retained = new Map<string, number>();
  const next = [...records].reverse().filter(item => {
    if (item.status === 'pending') return true;
    const count = retained.get(item.userId) || 0;
    retained.set(item.userId, count + 1);
    return count < 500;
  }).reverse();
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(`${filePath}.tmp`, filePath);
  deliveries = next;
  indexRecords(next);
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
  commitRecords([...load(), {
    id: randomUUID(), userId, text, botId: target.botToken.split(':')[0], chatId: target.chatId,
    messageIds: [...messageIds], status: 'sent', createdAt: Date.now(), sentAt: Date.now(), attempts: 1, nextAttemptAt: 0,
  }]);
}

async function deliver(record: TelegramDelivery): Promise<DeliveryResult> {
  const existing = inFlight.get(record.id);
  if (existing) return existing;
  const task = (async (): Promise<DeliveryResult> => {
    const target = getUserTelegram(record.userId);
    // A network send may take seconds. Keep the last durable state in memory
    // until the outcome is itself committed (never mutate the live record).
    const next = { ...record, messageIds: [...record.messageIds] };
    // Do not combine a saved old bot/chat with a newly changed destination.
    if (!target?.confirmedAt || !target.botToken || !target.chatId || target.botToken.split(':')[0] !== record.botId || target.chatId !== record.chatId) {
      next.status = 'failed';
      next.error = 'Telegram відключено або одержувач змінився. Старе повідомлення не перенаправлено.';
    } else {
      next.attempts++;
      const result = await telegramDispatchQueue.schedule(record.botId, record.chatId,
        () => sendTelegramMessage(record.text, {
          botToken: target.botToken, chatId: target.chatId, startPart: record.messageIds.length,
        }));
      next.messageIds.push(...result.messageIds);
      if (result.success) {
        next.status = 'sent';
        next.sentAt = Date.now();
        next.error = undefined;
      } else {
        next.error = result.error;
        next.status = result.retryable && next.attempts < 8 && Date.now() - next.createdAt < 24 * 3600 * 1000 ? 'pending' : 'failed';
        next.nextAttemptAt = Date.now() + Math.max(result.retryAfterSeconds || 0, Math.min(900, 5 * 2 ** next.attempts)) * 1000;
      }
    }
    commitRecords(load().map(item => item.id === record.id ? next : item));
    return { success: next.status === 'sent', queued: next.status === 'pending', error: next.error, deliveryId: next.id, messageIds: [...next.messageIds] };
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
  commitRecords([...load(), record]);
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
