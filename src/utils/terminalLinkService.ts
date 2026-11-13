import type { ExchangeId, MarketType, UserProfile } from '../types';
import { sendTickerToMetaScalp, type MetaScalpSettings } from './metaScalpService';

export type TerminalProvider = 'metascalp' | 'tiger' | 'vataga' | 'none';
export type TerminalLinkSource = 'screener' | 'formations' | 'early' | 'favorites' | 'chart' | 'terminal' | 'alerts' | 'impulses' | 'densities' | 'surveillance';

export const LINK_SOURCES: Array<{ id: TerminalLinkSource; label: string; description: string }> = [
  { id: 'screener', label: 'Скрінер', description: 'Кнопки лінковки у списку монет' },
  { id: 'formations', label: 'Формації', description: 'Звичайні формації та їхні картки' },
  { id: 'early', label: 'Раннє виявлення W/M', description: 'Попередні формації без впливу на їхній пошук' },
  { id: 'favorites', label: 'Обрані монети', description: 'Швидке відкриття зі списку обраних' },
  { id: 'chart', label: 'Повноекранний графік', description: 'Кнопка на графіку та відкриття монети' },
  { id: 'terminal', label: 'Термінал h00k', description: 'Кнопка зовнішнього термінала у власному терміналі' },
  { id: 'alerts', label: 'Цінові сповіщення', description: 'Підготовка до лінковки зі сповіщень' },
  { id: 'impulses', label: 'Імпульси й волатильність', description: 'Підготовка до передачі сигналів руху' },
  { id: 'densities', label: 'Щільності BID/ASK', description: 'Підготовка до передачі сигналів стакана' },
  { id: 'surveillance', label: 'Спостереження', description: 'Підготовка до передачі сигналів моніторингу' },
];

export interface TerminalLinkSettings {
  provider: TerminalProvider;
  enabled: boolean;
  sources: Record<TerminalLinkSource, boolean>;
  /** Deliberate user clicks / existing chart-selection behavior, not unsolicited alerts. */
  switchOnChartOpen: boolean;
  /** Reserved until individual real-time event sources are connected and tested. */
  autoSignals: boolean;
  /** Only meaningful when an actual 0-100 quality score is available. */
  minQuality: number;
  cooldownMs: number;
  tigerPort: number;
  tigerGroup: string;
  /** Optional per-source group overrides; terminal-specific and validated before sending. */
  metaScalpGroups: Partial<Record<TerminalLinkSource, string>>;
  tigerGroups: Partial<Record<TerminalLinkSource, string>>;
}

const DEFAULT_SOURCES: Record<TerminalLinkSource, boolean> = {
  screener: true, formations: true, early: true, favorites: true, chart: true, terminal: true,
  alerts: false, impulses: false, densities: false, surveillance: false,
};

export const DEFAULT_TERMINAL_LINK_SETTINGS: TerminalLinkSettings = {
  provider: 'metascalp', enabled: true, sources: DEFAULT_SOURCES,
  switchOnChartOpen: true, autoSignals: false, minQuality: 0, cooldownMs: 1200,
  tigerPort: 7819, tigerGroup: 'A', metaScalpGroups: {}, tigerGroups: {},
};

export function normalizeTerminalLinkSettings(saved?: Partial<TerminalLinkSettings> | null): TerminalLinkSettings {
  const validProviders = ['metascalp', 'tiger', 'vataga', 'none'];
  const provider = validProviders.includes(saved?.provider || '') ? saved!.provider! : 'metascalp';
  const port = Number(saved?.tigerPort);
  const quality = Number(saved?.minQuality);
  const cooldown = Number(saved?.cooldownMs);
  const boolSources = Object.fromEntries(
    LINK_SOURCES.map(({ id }) => [id, typeof saved?.sources?.[id] === 'boolean' ? saved.sources[id] : DEFAULT_SOURCES[id]])
  ) as Record<TerminalLinkSource, boolean>;
  return {
    ...DEFAULT_TERMINAL_LINK_SETTINGS, ...saved, provider, sources: boolSources,
    enabled: saved?.enabled !== false,
    switchOnChartOpen: saved?.switchOnChartOpen !== false,
    autoSignals: false, // Never silently enable background signal delivery.
    minQuality: Number.isFinite(quality) ? Math.min(100, Math.max(0, Math.round(quality))) : 0,
    cooldownMs: Number.isFinite(cooldown) ? Math.max(0, Math.min(60000, Math.round(cooldown))) : 1200,
    tigerPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7819,
    tigerGroup: normalizeTigerGroup(saved?.tigerGroup) ?? 'A',
    metaScalpGroups: sanitizeGroups(saved?.metaScalpGroups, normalizeMetaScalpGroup),
    tigerGroups: sanitizeGroups(saved?.tigerGroups, normalizeTigerGroup),
  };
}

function sanitizeGroups(raw: Partial<Record<TerminalLinkSource, string>> | undefined, valid: (s: string | undefined) => string | null) {
  return Object.fromEntries(LINK_SOURCES.flatMap(({ id }) => {
    const group = valid(raw?.[id]);
    return group ? [[id, group]] : [];
  })) as Partial<Record<TerminalLinkSource, string>>;
}

export function normalizeMetaScalpGroup(group?: string): string | null {
  const str = String(group ?? '').trim();
  if (!/^\d{1,3}$/.test(str)) return null;
  const n = Number(str);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? String(n).padStart(3, '0') : null;
}

export function normalizeTigerGroup(group?: string): string | null {
  const value = String(group ?? '').trim().toUpperCase();
  return /^[A-Z]$/.test(value) || /^(?:[0-9]|10|11)$/.test(value) ? value : null;
}

export function getUserTerminalLinkSettings(userId?: string, profile?: Pick<UserProfile, 'uid' | 'terminalLinkSettings'> | null): TerminalLinkSettings {
  if (!userId || profile?.uid !== userId) return normalizeTerminalLinkSettings({ provider: 'none', enabled: false });
  return normalizeTerminalLinkSettings(profile.terminalLinkSettings);
}

export function terminalLabel(provider: TerminalProvider): string {
  return { metascalp: 'MetaScalp', tiger: 'Tiger', vataga: 'Vataga', none: 'Вимкнено' }[provider];
}

export interface TerminalLinkResult {
  success: boolean;
  terminal: TerminalProvider;
  message: string;
  ticker: string;
  group: string;
  copiedToClipboard?: boolean;
}

async function clipboardFallback(ticker: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(ticker);
      return true;
    }
  } catch { /* Browser denied clipboard */ }
  return false;
}

async function tigerSocketCommand(port: number, payload: string, timeoutMs = 2800): Promise<{ ok: boolean; message: string }> {
  if (typeof WebSocket === 'undefined') return { ok: false, message: 'Цей браузер не підтримує WebSocket.' };
  return await new Promise(resolve => {
    let settled = false;
    let socket: WebSocket | null = null;
    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      resolve({ ok, message });
    };
    const timer = setTimeout(() => finish(false, 'Tiger не відповів. Перевірте локальний сервер сигналів і дозвіл браузера.'), timeoutMs);
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}`);
      socket.onopen = () => { try { socket?.send(payload); } catch { finish(false, 'Не вдалося надіслати команду в Tiger.'); } };
      socket.onmessage = event => {
        const raw = String(event.data);
        if (payload === 'ping' && (raw.toLowerCase() === 'pong' || raw.includes('"Pong"'))) {
          finish(true, 'Локальний сервер Tiger відповідає.');
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          if (payload === 'ping' && (parsed?.title === 'Pong' || parsed?.response?.type === 'successfully')) {
            finish(true, 'Локальний сервер Tiger відповідає.');
          } else if (parsed?.response?.type === 'successfully') {
            finish(true, String(parsed?.message || 'Tiger підтвердив перемикання.'));
          } else if (parsed?.response?.type === 'error' || parsed?.response?.error) {
            finish(false, String(parsed?.response?.error?.message || parsed?.message || 'Tiger відхилив команду.'));
          }
        } catch { /* Ignore unrelated messages and wait for acknowledgement. */ }
      };
      socket.onerror = () => finish(false, 'Не вдалося підключитися до Tiger на цьому комп’ютері.');
      socket.onclose = () => finish(false, 'Tiger закрив з’єднання без підтвердження.');
    } catch {
      finish(false, 'Браузер заблокував локальне WebSocket-з’єднання Tiger.');
    }
  });
}

export async function testTigerConnection(port: number): Promise<{ ok: boolean; message: string }> {
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 7819;
  return tigerSocketCommand(validPort, 'ping');
}

export async function sendToSelectedTerminal(
  symbol: string,
  exchange: ExchangeId,
  marketType: MarketType,
  source: TerminalLinkSource,
  preferences: TerminalLinkSettings,
  metaScalp: MetaScalpSettings,
  quality?: number
): Promise<TerminalLinkResult> {
  const p = normalizeTerminalLinkSettings(preferences);
  const ticker = symbol.trim().toUpperCase();
  const terminal = p.provider;
  const base = { terminal, ticker, group: '', success: false };
  if (!p.enabled || terminal === 'none') return { ...base, message: 'Лінковка вимкнена в профілі.' };
  if (!p.sources[source]) return { ...base, message: 'Для цього розділу передачу монет вимкнено в профілі.' };
  if (!/^[A-Z0-9:_-]{2,40}$/.test(ticker)) return { ...base, message: 'Некоректний тикер для передавання.' };
  if (p.minQuality > 0 && (quality === undefined || !Number.isFinite(quality) || quality < p.minQuality)) {
    return { ...base, message: quality === undefined ? 'Для цієї монети немає перевіреної оцінки якості сигналу.' : `Якість сигналу нижче ${p.minQuality}/100.` };
  }
  if (terminal === 'metascalp') {
    if (!metaScalp.enabled) return { ...base, message: 'MetaScalp вимкнено в налаштуваннях.' };
    const group = normalizeMetaScalpGroup(p.metaScalpGroups[source] || metaScalp.binding);
    if (!group) return { ...base, message: 'Група MetaScalp має бути від 001 до 500.' };
    const result = await sendTickerToMetaScalp(ticker, exchange, marketType, { ...metaScalp, binding: group });
    return { terminal, success: result.success, ticker: result.ticker, group, message: result.message, copiedToClipboard: result.copiedToClipboard };
  }
  if (terminal === 'tiger') {
    const group = normalizeTigerGroup(p.tigerGroups[source] || p.tigerGroup);
    if (!group) return { ...base, message: 'Неправильна група Tiger. Доступні A–Z або 0–11.' };
    const payload = JSON.stringify({ type: 'setLinkSymbol', e: exchange.toUpperCase(), m: marketType.toUpperCase(), symbol: ticker, linkGroup: group });
    const result = await tigerSocketCommand(p.tigerPort, payload);
    const copied = result.ok ? false : await clipboardFallback(ticker);
    return { terminal, success: result.ok, ticker, group, message: result.message, copiedToClipboard: copied };
  }
  const copied = await clipboardFallback(ticker);
  return {
    terminal, success: false, ticker, group: '',
    message: 'Vataga: відкриття через API ще не активовано — виробник не опублікував формат локальної команди. Налаштуйте «Інтеграція додатків» у Vataga; до підтвердження протоколу доступне копіювання тикера.',
    copiedToClipboard: copied,
  };
}
