import { publicPriceFeed } from './publicPriceFeed';
import { exchangeFetch } from './exchangeHttp';
import fs from 'fs';
import path from 'path';
import type { PriceAlert, AlertHistoryItem, ExchangeId, MarketType } from '../src/types';
import { sendUserTelegramMessage, getTelegramDelivery } from './telegramDelivery';
import { isUserTelegramCategoryAllowed } from './siteNotificationPrefs';
import { getUserTelegram, saveUserTelegram, loadUserTelegram } from './userTelegram';
export { getUserTelegram, saveUserTelegram, loadUserTelegram } from './userTelegram';
import type { SetupInstance } from './surveillance/types';
import { validateSetupAlertsMath } from './surveillance/setupValidation';
import { normalizeLanguage, telegramText, type SupportedLanguage } from '../src/locales';

const DATA_DIR = path.join(process.cwd(), 'server', 'data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const HISTORY_FILE = path.join(DATA_DIR, 'alert_history.json');
const DELETED_ALERTS_FILE = path.join(DATA_DIR, 'deleted_alerts.json');

// Ensure directory exists
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
      console.error('Failed to create server/data directory:', e);
    }
  }
}

// Format price nicely
function formatPrice(val: number): string {
  if (!val && val !== 0) return '0.00';
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val >= 1) return val.toFixed(4);
  if (val >= 0.0001) return val.toFixed(6);
  return val.toFixed(8);
}

// In-memory caches
let alertsCache: PriceAlert[] = [];
let isAlertsLoaded = false;

let historyCache: AlertHistoryItem[] = [];
let isHistoryLoaded = false;

let monitorInterval: any = null;
const deletedAlertIds = new Set<string>();
let areDeletedAlertIdsLoaded = false;
const alertIdentity = (userId: string, id: string) => `${userId}:${id}`;

function loadDeletedAlertIds() {
  if (areDeletedAlertIdsLoaded) return;
  ensureDataDir();
  if (fs.existsSync(DELETED_ALERTS_FILE)) {
    const stored: unknown = JSON.parse(fs.readFileSync(DELETED_ALERTS_FILE, 'utf-8'));
    if (!Array.isArray(stored) || stored.some(id => typeof id !== 'string')) {
      throw new Error('Invalid deleted alert persistence');
    }
    for (const id of stored) deletedAlertIds.add(id);
  }
  areDeletedAlertIdsLoaded = true;
}

function saveDeletedAlertIds() {
  ensureDataDir();
  const temporary = `${DELETED_ALERTS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...deletedAlertIds]), 'utf-8');
  fs.renameSync(temporary, DELETED_ALERTS_FILE);
}

export function getUserLanguage(userId?: string): SupportedLanguage {
  return normalizeLanguage(getUserTelegram(userId)?.language);
}

// --- Alerts persistence ---
export function loadAlerts(): PriceAlert[] {
  loadDeletedAlertIds();
  if (isAlertsLoaded) return alertsCache;
  try {
    ensureDataDir();
    if (fs.existsSync(ALERTS_FILE)) {
      const raw = fs.readFileSync(ALERTS_FILE, 'utf-8');
      alertsCache = JSON.parse(raw);
    } else {
      alertsCache = [];
    }
  } catch (err) {
    console.error('Failed to read alerts.json:', err);
    alertsCache = [];
  }
  isAlertsLoaded = true;
  alertsCache = alertsCache.filter(a => !deletedAlertIds.has(alertIdentity(a.userId || 'guest', a.id)));
  // Repair stale alert snapshots from the durable trigger history on startup.
  // A Telegram notification already processed must not be armed again.
  let repaired = false;
  for (const alert of alertsCache) {
    const history = findProcessedAlertHistory(alert);
    if (history && (!alert.triggered || alert.isActive)) {
      alert.triggered = true;
      alert.isActive = false;
      alert.triggeredAt = history.triggeredAt;
      alert.triggeredPrice = history.triggeredPrice;
      repaired = true;
    }
  }
  if (repaired && !saveAlerts(alertsCache)) {
    console.error('[Alerts] Could not persist restored triggered states; notification dispatch is unsafe');
  }
  return alertsCache;
}

export function saveAlerts(alerts: PriceAlert[]): boolean {
  try {
    ensureDataDir();
    const temp = `${ALERTS_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(alerts, null, 2), 'utf-8');
    fs.renameSync(temp, ALERTS_FILE);
    alertsCache = alerts;
    return true;
  } catch (err) {
    console.error('Failed to save alerts.json:', err);
    return false;
  }
}

// --- History persistence ---
export function loadHistory(): AlertHistoryItem[] {
  if (isHistoryLoaded) return historyCache;
  try {
    ensureDataDir();
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      historyCache = JSON.parse(raw);
    } else {
      historyCache = [];
    }
  } catch (err) {
    console.error('Failed to read alert_history.json:', err);
    historyCache = [];
  }
  isHistoryLoaded = true;
  return historyCache;
}

export function saveHistory(items: AlertHistoryItem[]): boolean {
  try {
    ensureDataDir();
    historyCache = items;
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(items, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to save alert_history.json:', err);
    return false;
  }
}

/** Completed alert cycles remain terminal across stale browser syncs and server restarts. */
function findProcessedAlertHistory(alert: PriceAlert): AlertHistoryItem | undefined {
  const epoch = alert.deliveryEpoch ?? 0;
  return loadHistory().find(item =>
    item.userId === alert.userId &&
    item.alertId === alert.id &&
    (item.deliveryEpoch ?? 0) === epoch
  );
}

export function getAlertHistory(userId?: string): AlertHistoryItem[] {
  if (!userId || userId === 'guest') return [];
  const all = loadHistory();
  return all.filter((h) => h.userId === userId).map(item => {
    const delivery = item.telegramDeliveryId ? getTelegramDelivery(userId, item.telegramDeliveryId) : undefined;
    return delivery ? { ...item, telegramSent: delivery.status === 'sent', telegramPending: delivery.status === 'pending', telegramError: delivery.error, telegramMessageIds: delivery.messageIds } : item;
  });
}

export function addHistoryItem(item: AlertHistoryItem): void {
  const history = loadHistory();
  const ownHistory = [item, ...history.filter(entry =>
    entry.userId === item.userId &&
    !(item.alertId && entry.alertId === item.alertId && (entry.deliveryEpoch ?? 0) === (item.deliveryEpoch ?? 0))
  )].slice(0, 500);
  saveHistory([...ownHistory, ...history.filter(entry => entry.userId !== item.userId)]);
}

export function clearAlertHistory(userId?: string): number {
  if (!userId || userId === 'guest') return 0;
  const history = loadHistory();
  const remaining = history.filter((h) => h.userId !== userId);
  const clearedCount = history.length - remaining.length;
  saveHistory(remaining);
  return clearedCount;
}

export function deleteHistoryItem(id: string, userId?: string): boolean {
  if (!userId || userId === 'guest') return false;
  const history = loadHistory();
  const filtered = history.filter((h) => !(h.id === id && h.userId === userId));
  if (filtered.length !== history.length) {
    saveHistory(filtered);
    return true;
  }
  return false;
}

// Get all alerts (strictly filtered by user, never leaked to guests)
export function getAllAlerts(userId?: string): PriceAlert[] {
  if (!userId || userId === 'guest') return [];
  const all = loadAlerts();
  return all.filter((a) => a.userId === userId);
}

// Create alert
export function createAlert(
  data: Omit<PriceAlert, 'id' | 'createdAt' | 'triggered' | 'isActive'> & {
    id?: string;
    createdAt?: number;
    isActive?: boolean;
    userId?: string;
    telegramBotToken?: string;
    telegramChatId?: string;
  }
): PriceAlert {
  const alerts = loadAlerts();
  const userId = data.userId || 'guest';

  if (data.language) saveUserTelegram(userId, { language: data.language });

  const userTg = getUserTelegram(userId);
  const effectiveLanguage = normalizeLanguage(data.language || userTg?.language);

  const alertId = data.id || `alert_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  if (deletedAlertIds.has(alertIdentity(userId, alertId))) throw new Error('Сповіщення вже видалено');
  const existing = alerts.find(a => a.id === alertId && a.userId === userId);
  if (existing) return existing;

  const newAlert: PriceAlert = {
    id: alertId,
    userId,
    symbol: data.symbol.toUpperCase().replace('/', '').trim(),
    exchange: data.exchange,
    marketType: data.marketType,
    targetPrice: Number(data.targetPrice),
    condition: data.condition,
    note: data.note ? String(data.note).trim() : undefined,
    formationName: data.formationName ? String(data.formationName).trim() : undefined,
    levelType: data.levelType || 'custom',
    createdAt: data.createdAt || Date.now(),
    isActive: data.isActive !== undefined ? data.isActive : true,
    triggered: false,
    language: effectiveLanguage,
  };

  alerts.unshift(newAlert);
  saveAlerts(alerts);
  return newAlert;
}

// Create batch of alerts (e.g. 3 levels: Entry, Take-Profit, Stop-Loss)
export function createAlertsBatch(
  userId: string,
  alertsList: Array<
    Omit<PriceAlert, 'id' | 'createdAt' | 'triggered' | 'isActive'> & {
      id?: string;
      isActive?: boolean;
      telegramBotToken?: string;
      telegramChatId?: string;
    }
  >,
  telegramBotToken?: string,
  telegramChatId?: string,
  language?: SupportedLanguage
): PriceAlert[] {
  const alerts = loadAlerts();

  if (language) saveUserTelegram(userId, { language });

  const userTg = getUserTelegram(userId);
  const effectiveLanguage = normalizeLanguage(language || userTg?.language);

  const createdAlerts: PriceAlert[] = [];
  let index = 0;

  for (const item of alertsList) {
    const alertId = item.id || `alert_${Date.now()}_${Math.random().toString(36).substring(2, 8)}_${index++}`;
    if (deletedAlertIds.has(alertIdentity(userId, alertId))) continue;
    const existing = alerts.find(a => a.id === alertId && a.userId === userId);
    if (existing) {
      createdAlerts.push(existing);
      continue;
    }
    const newAlert: PriceAlert = {
      id: alertId,
      userId,
      symbol: item.symbol.toUpperCase().replace('/', '').trim(),
      exchange: item.exchange,
      marketType: item.marketType,
      targetPrice: Number(item.targetPrice),
      condition: item.condition,
      note: item.note ? String(item.note).trim() : undefined,
      formationName: item.formationName ? String(item.formationName).trim() : undefined,
      levelType: item.levelType || 'custom',
      createdAt: Date.now() + index,
      isActive: item.isActive !== undefined ? item.isActive : true,
      triggered: false,
      language: normalizeLanguage(item.language || effectiveLanguage),
    };

    alerts.unshift(newAlert);
    createdAlerts.push(newAlert);
  }

  saveAlerts(alerts);
  return createdAlerts;
}

/**
 * Creates an atomic group of 3 Price Alerts for a setup:
 * setupId
 *  ├── ENTRY
 *  ├── TARGET
 *  └── STOP
 *
 * Mathematically validates before creation:
 * For LONG:  STOP < ENTRY < TARGET
 * For SHORT: TARGET < ENTRY < STOP
 */
export function createSetupAlertsGroup(
  userId: string,
  setup: SetupInstance,
  currentPrice?: number,
  autoActivate = true
): { success: boolean; alerts?: PriceAlert[]; error?: string } {
  const mathValidation = validateSetupAlertsMath(setup);
  if (!mathValidation.valid) {
    return {
      success: false,
      error: mathValidation.reason || 'Mathematical validation failed for setup levels',
    };
  }

  const { entry, target, stop } = mathValidation;
  const curPrice = currentPrice || entry;

  // ENTRY:
  // For LONG: if currentPrice > entry, triggers when dropping to entry ('lte'); if below, when reclaiming ('gte')
  // For SHORT: if currentPrice < entry, triggers when bouncing to entry ('gte'); if above, when dropping ('lte')
  const entryCondition =
    setup.direction === 'LONG'
      ? curPrice >= entry
        ? 'lte'
        : 'gte'
      : curPrice <= entry
      ? 'gte'
      : 'lte';

  // TARGET:
  // For LONG: triggers when price rises to or exceeds target ('gte')
  // For SHORT: triggers when price falls to or drops below target ('lte')
  const targetCondition = setup.direction === 'LONG' ? 'gte' : 'lte';

  // STOP:
  // For LONG: triggers when price falls to or drops below stop ('lte')
  // For SHORT: triggers when price rises to or exceeds stop ('gte')
  const stopCondition = setup.direction === 'LONG' ? 'lte' : 'gte';

  const userTg = getUserTelegram(userId);
  const now = Date.now();

  const alertsToCreate: PriceAlert[] = [
    {
      id: `${setup.id}_ENTRY`,
      userId,
      setupId: setup.id,
      setupRole: 'ENTRY',
      symbol: setup.symbol.toUpperCase().replace('/', '').trim(),
      exchange: setup.exchange,
      marketType: setup.marketType,
      targetPrice: Number(entry),
      condition: entryCondition,
      levelType: 'entry',
      formationName: setup.type,
      note: `[Setup ${setup.direction}] Точка входу (${setup.type} ${setup.timeframe})`,
      createdAt: now,
      isActive: autoActivate,
      triggered: false,
      language: normalizeLanguage(userTg?.language),
    },
    {
      id: `${setup.id}_TARGET`,
      userId,
      setupId: setup.id,
      setupRole: 'TARGET',
      symbol: setup.symbol.toUpperCase().replace('/', '').trim(),
      exchange: setup.exchange,
      marketType: setup.marketType,
      targetPrice: Number(target),
      condition: targetCondition,
      levelType: 'target',
      formationName: setup.type,
      note: `[Setup ${setup.direction}] Ціль Take-Profit (TP) +${Math.abs(((target - entry) / entry) * 100).toFixed(1)}%`,
      createdAt: now + 1,
      isActive: autoActivate,
      triggered: false,
      language: normalizeLanguage(userTg?.language),
    },
    {
      id: `${setup.id}_STOP`,
      userId,
      setupId: setup.id,
      setupRole: 'STOP',
      symbol: setup.symbol.toUpperCase().replace('/', '').trim(),
      exchange: setup.exchange,
      marketType: setup.marketType,
      targetPrice: Number(stop),
      condition: stopCondition,
      levelType: 'stop_loss',
      formationName: setup.type,
      note: `[Setup ${setup.direction}] Скасування Stop-Loss (SL) -${Math.abs(((entry - stop) / entry) * 100).toFixed(1)}%`,
      createdAt: now + 2,
      isActive: autoActivate,
      triggered: false,
      language: normalizeLanguage(userTg?.language),
    },
  ];

  const alerts = loadAlerts();
  for (const newAlert of alertsToCreate) {
    if (deletedAlertIds.has(alertIdentity(userId, newAlert.id))) continue;
    const existingIdx = alerts.findIndex((a) => a.id === newAlert.id && a.userId === userId);
    if (existingIdx >= 0) {
      // Repeated analysis must not rearm a fired setup or undo a manual pause.
      Object.assign(newAlert, alerts[existingIdx]);
    } else {
      alerts.unshift(newAlert);
    }
  }

  saveAlerts(alerts);
  return { success: true, alerts: alertsToCreate.filter(a => !deletedAlertIds.has(alertIdentity(userId, a.id))) };
}

// Sync user alerts batch from client/Firestore with smart merge
export function syncUserAlerts(
  userId: string,
  userAlerts: PriceAlert[],
  telegramBotToken?: string,
  telegramChatId?: string,
  language?: SupportedLanguage
): PriceAlert[] {
  if (language) saveUserTelegram(userId, { language });

  const all = loadAlerts();
  const userTg = getUserTelegram(userId);
  const effectiveLanguage = normalizeLanguage(language || userTg?.language);

  // Map of existing alerts on server for this user
  const existingUserAlerts = new Map<string, PriceAlert>();
  for (const a of all) {
    if (a.userId === userId) {
      existingUserAlerts.set(a.id, a);
    }
  }

  // Merge incoming alerts
  const mergedUserAlerts: PriceAlert[] = [];
  const processedIds = new Set<string>();

  for (const rawIncoming of userAlerts) {
    const { telegramBotToken: _token, telegramChatId: _chat, ...incoming } = rawIncoming;
    if (incoming.userId && incoming.userId !== userId) continue;
    if (deletedAlertIds.has(alertIdentity(userId, incoming.id))) continue;
    processedIds.add(incoming.id);
    const existing = existingUserAlerts.get(incoming.id);

    // The server is authoritative for an existing alert's lifecycle.
    // A delayed Firestore snapshot must never re-arm a sent notification;
    // nor may an old triggered snapshot undo a deliberate manual restart.
    const processed = existing ? undefined : findProcessedAlertHistory({ ...incoming, userId });
    mergedUserAlerts.push({
      ...incoming,
      userId,
      isActive: existing ? existing.isActive : processed ? false : incoming.isActive,
      triggered: existing ? existing.triggered : processed ? true : incoming.triggered,
      triggeredAt: existing ? existing.triggeredAt : processed ? processed.triggeredAt : incoming.triggeredAt,
      triggeredPrice: existing ? existing.triggeredPrice : processed ? processed.triggeredPrice : incoming.triggeredPrice,
      deliveryEpoch: existing ? existing.deliveryEpoch : incoming.deliveryEpoch,
      language: normalizeLanguage(incoming.language || existing?.language || effectiveLanguage),
    });
  }

  // Absence in a stale browser snapshot is not a deletion. Deletions use the DELETE endpoint.
  for (const [id, existing] of existingUserAlerts.entries()) {
    if (!processedIds.has(id)) {
      mergedUserAlerts.push({
        ...existing,
        telegramBotToken: undefined,
        telegramChatId: undefined,
        language: normalizeLanguage(existing.language || effectiveLanguage),
      });
    }
  }

  const otherAlerts = all.filter((a) => a.userId !== userId);
  const updatedAll = [...mergedUserAlerts, ...otherAlerts];
  saveAlerts(updatedAll);

  return mergedUserAlerts;
}

// Delete alert
export function deleteAlert(id: string, userId?: string): boolean {
  if (!userId || userId === 'guest') return false;
  const alerts = loadAlerts();
  const initialCount = alerts.length;
  // Record deletion even when it arrives before a delayed create request.
  deletedAlertIds.add(alertIdentity(userId, id));
  saveDeletedAlertIds();
  const filtered = alerts.filter(a => !(a.id === id && a.userId === userId));

  if (filtered.length !== initialCount) {
    saveAlerts(filtered);
    return true;
  }
  return false;
}

// Toggle alert active state
export function toggleAlert(id: string, userId?: string, isActive?: boolean): PriceAlert | null {
  if (!userId || userId === 'guest') return null;
  const alerts = loadAlerts();
  const alert = alerts.find((a) => a.id === id && a.userId === userId);
  if (alert) {
    alert.isActive = isActive ?? !alert.isActive;
    // Only this explicit user action starts a new delivery cycle.
    if (alert.isActive && alert.triggered) {
      alert.deliveryEpoch = (alert.deliveryEpoch ?? 0) + 1;
      alert.triggered = false;
      alert.triggeredAt = undefined;
      alert.triggeredPrice = undefined;
    }
    saveAlerts(alerts);
    return alert;
  }
  return null;
}

// Clear triggered alerts
export function clearTriggeredAlerts(userId?: string): number {
  if (!userId || userId === 'guest') return 0;
  const alerts = loadAlerts();
  const remaining = alerts.filter((a) => {
    if (!a.triggered) return true;
    if (a.userId !== userId) return true;
    return false;
  });
  const clearedCount = alerts.length - remaining.length;
  for (const removed of alerts) {
    if (!remaining.includes(removed)) deletedAlertIds.add(alertIdentity(removed.userId || 'guest', removed.id));
  }
  if (clearedCount > 0) saveDeletedAlertIds();
  saveAlerts(remaining);
  return clearedCount;
}

// HTML escaping helper for Telegram
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Fetch single ticker price from exchange with robust cross-exchange fallbacks
async function fetchCurrentPrice(exchange: ExchangeId, market: MarketType, symbol: string): Promise<number | null> {
  const cleanSymbol = symbol.toUpperCase().replace('/', '').trim();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  };

  const urls = exchange === 'binance'
    ? market === 'futures'
      ? [`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${cleanSymbol}`]
      : [`https://data-api.binance.vision/api/v3/ticker/price?symbol=${cleanSymbol}`,
         `https://api.binance.com/api/v3/ticker/price?symbol=${cleanSymbol}`]
    : [`https://api.bybit.com/v5/market/tickers?category=${market === 'futures' ? 'linear' : 'spot'}&symbol=${cleanSymbol}`,
       `https://api.bytick.com/v5/market/tickers?category=${market === 'futures' ? 'linear' : 'spot'}&symbol=${cleanSymbol}`];
  for (const url of urls) {
    try {
      const res = await exchangeFetch(url, { headers, signal: AbortSignal.timeout(3500) });
      if (!res.ok) continue;
      const data = await res.json();
      const price = Number(exchange === 'binance' ? data.price : data?.result?.list?.[0]?.lastPrice);
      if (Number.isFinite(price) && price > 0) return price;
    } catch {}
  }

  return null;
}

// Check active alerts against live prices
let checkInFlight = false;
export async function checkAlertsOnce(userId?: string) {
  if (checkInFlight) return;
  checkInFlight = true;
  try {
    await checkAlertsInternal(userId);
  } finally {
    checkInFlight = false;
  }
}

async function checkAlertsInternal(userId?: string) {
  const alerts = loadAlerts();
  const allActive = alerts.filter(a => a.isActive && !a.triggered);
  // A manual /api/cron/run for one user must NEVER replace the global
  // exchange subscription universe with that user's private subset.
  // Keep network subscriptions global but evaluate/notify only the caller.
  const activeAlerts = userId ? allActive.filter(a => a.userId === userId) : allActive;
  const watched = new Map<string, { exchange: ExchangeId; market: MarketType; symbol: string }>();
  for (const alert of allActive) {
    const key = `${alert.exchange}:${alert.marketType}:${alert.symbol}`;
    if (!watched.has(key))
      watched.set(key, { exchange: alert.exchange, market: alert.marketType, symbol: alert.symbol });
  }
  publicPriceFeed.watch([...watched.values()]);
  if (activeAlerts.length === 0) return;

  // Group prices only for the subset actually being checked.
  const uniqueKeys = new Map<string, { exchange: ExchangeId; market: MarketType; symbol: string }>();
  for (const a of activeAlerts) {
    const key = `${a.exchange}:${a.marketType}:${a.symbol}`;
    if (!uniqueKeys.has(key))
      uniqueKeys.set(key, { exchange: a.exchange, market: a.marketType, symbol: a.symbol });
  }

  // Fetch only prices not yet available from a fresh exchange WS message.
  const priceMap = new Map<string, number>();
  await Promise.all(
    Array.from(uniqueKeys.entries()).map(async ([key, item]) => {
      const p = publicPriceFeed.current({ exchange: item.exchange, market: item.market, symbol: item.symbol })
        ?? await fetchCurrentPrice(item.exchange, item.market, item.symbol);
      if (p !== null && !isNaN(p)) {
        priceMap.set(key, p);
      }
    })
  );

  let updated = false;

  for (const candidate of activeAlerts) {
    const alert = loadAlerts().find((a) => a.id === candidate.id && a.userId === candidate.userId);
    if (!alert || !alert.isActive || alert.triggered) continue;
    const prior = findProcessedAlertHistory(alert);
    if (prior) {
      alert.triggered = true;
      alert.isActive = false;
      alert.triggeredAt = prior.triggeredAt;
      alert.triggeredPrice = prior.triggeredPrice;
      if (!saveAlerts(loadAlerts())) console.error('[Alerts] Failed to repair a previously fired notification');
      continue;
    }
    const key = `${alert.exchange}:${alert.marketType}:${alert.symbol}`;
    const currentPrice = priceMap.get(key);
    if (currentPrice === undefined) continue;

    let isTriggered = false;
    if (alert.condition === 'gte' && currentPrice >= alert.targetPrice) {
      isTriggered = true;
    } else if (alert.condition === 'lte' && currentPrice <= alert.targetPrice) {
      isTriggered = true;
    }

    if (isTriggered) {
      alert.triggered = true;
      alert.isActive = false;
      alert.triggeredAt = Date.now();
      alert.triggeredPrice = currentPrice;
      updated = true;
      if (!saveAlerts(loadAlerts())) {
        // Never send a message that cannot be marked completed durably:
        // otherwise it could be sent again after the next restart.
        alert.triggered = false;
        alert.isActive = true;
        alert.triggeredAt = undefined;
        alert.triggeredPrice = undefined;
        console.error('[Alerts] Could not persist fired state; skipped Telegram notification');
        continue;
      }

      console.log(`[ALERT TRIGGERED] ${alert.symbol} target: ${alert.targetPrice}, live price: ${currentPrice}, condition: ${alert.condition}`);

      const language = normalizeLanguage(getUserTelegram(alert.userId)?.language || alert.language);
      const localeTag: Record<SupportedLanguage, string> = {
        uk: 'uk-UA',
        en: 'en-US',
        ru: 'ru-RU',
        pl: 'pl-PL',
      };
      const timeStr = new Date(alert.triggeredAt).toLocaleTimeString(localeTag[language], { timeZone: 'Europe/Kyiv' });
      const dateStr = new Date(alert.triggeredAt).toLocaleDateString(localeTag[language], { timeZone: 'Europe/Kyiv' });

      const levelKey =
        alert.levelType === 'entry' ? 'levelEntry' :
        alert.levelType === 'target' ? 'levelTarget' :
        alert.levelType === 'stop_loss' ? 'levelStop' :
        'levelCustom';
      const levelTitle = telegramText(language, levelKey);
      const conditionLabel = telegramText(language, alert.condition === 'gte' ? 'conditionGte' : 'conditionLte');

      const safeSymbol = escapeHtml(alert.symbol);
      const safeFormation = alert.formationName ? escapeHtml(alert.formationName) : '';
      const safeNote = alert.note ? escapeHtml(alert.note) : '';
      const formationLine = safeFormation ? telegramText(language, 'formationLine', { formation: safeFormation }) : '';
      const levelLine = alert.levelType ? telegramText(language, 'levelLine', { level: levelTitle }) : '';
      const noteLine = safeNote ? telegramText(language, 'noteLine', { note: safeNote }) : '';

      const message = `${telegramText(language, 'priceAlertTitle')}\n\n${telegramText(language, 'priceAlertBody', {
        symbol: safeSymbol,
        exchange: alert.exchange.toUpperCase(),
        market: alert.marketType.toUpperCase(),
        currentPrice: formatPrice(currentPrice),
        targetPrice: formatPrice(alert.targetPrice),
        condition: conditionLabel,
        formationLine,
        levelLine,
        noteLine,
        date: dateStr,
        time: timeStr,
      })}`;

      let telegramSent = false;
      let telegramError: string | undefined = undefined;
      let telegramDeliveryId: string | undefined;
      let telegramMessageIds: number[] | undefined;
      let telegramPending = false;

      const userAllowedTelegram = isUserTelegramCategoryAllowed(alert.userId || '', {
        source: 'PRICE_ALERT', eventType: 'PRICE_ALERT',
        symbol: alert.symbol, exchange: alert.exchange, marketType: alert.marketType,
      });
      try {
        if (!userAllowedTelegram) {
          telegramError = 'Telegram-відправлення вимкнено в профілі користувача';
        } else {
        const sendRes = await sendUserTelegramMessage(alert.userId || '', message, `price:${alert.id}:epoch:${alert.deliveryEpoch ?? 0}`);
        telegramDeliveryId = sendRes.deliveryId;
        telegramMessageIds = sendRes.messageIds;
        telegramPending = Boolean(sendRes.queued);
        if (sendRes.success) {
          telegramSent = true;
          console.log(`[ALERT DISPATCHED] Successfully sent Telegram alert for ${alert.symbol} to user: ${alert.userId || 'default'}`);
        } else {
          telegramError = sendRes.error;
          console.warn(`[ALERT DISPATCH WARNING] Telegram notification for ${alert.symbol} was not delivered:`, sendRes.error);
        }
        }
      } catch (dispatchErr: any) {
        telegramError = dispatchErr?.message || telegramText(language, 'sendError');
        console.error(`[ALERT DISPATCH ERROR] Failed to send Telegram alert for ${alert.symbol}:`, dispatchErr);
      }

      // Record in Alert History
      const historyItem: AlertHistoryItem = {
        id: `hist_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        userId: alert.userId || 'guest',
        alertId: alert.id,
        symbol: alert.symbol,
        exchange: alert.exchange,
        marketType: alert.marketType,
        condition: alert.condition,
        targetPrice: alert.targetPrice,
        triggeredPrice: currentPrice,
        formationName: alert.formationName,
        levelType: alert.levelType,
        note: alert.note,
        triggeredAt: alert.triggeredAt,
        telegramSent,
        telegramError,
        telegramDeliveryId,
        deliveryEpoch: alert.deliveryEpoch ?? 0,
        telegramMessageIds,
        telegramPending,
        createdAt: new Date().toISOString(),
      };
      addHistoryItem(historyItem);
    }
  }

  if (updated) {
    saveAlerts(loadAlerts());
  }
}

// Start background monitor loop
export function startAlertMonitor(intervalMs: number = 6000) {
  if (monitorInterval) return;
  loadAlerts();
  loadHistory();
  loadUserTelegram();
  monitorInterval = setInterval(() => {
    checkAlertsOnce().catch((err) => {
      console.error('Error during alert check iteration:', err);
    });
  }, intervalMs);
  console.log(`Telegram price alert monitor started (interval: ${intervalMs}ms)`);
}

// Stop monitor
export function stopAlertMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}
