import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SITE_NOTIFICATIONS, normalizeSiteNotificationSettings, notificationEnabled,
  matchesNotificationScope, type SiteNotificationSettings, type SiteNotificationKind,
} from '../src/utils/siteNotifications';

/** Separate from Firebase UI profile: server cron must enforce explicit opt-in too. */
const file = path.join(process.cwd(), 'server/data/site_notification_settings_v2.json');
let cache: Map<string, SiteNotificationSettings> | null = null;
function store(): Map<string, SiteNotificationSettings> {
  if (cache) return cache;
  const result = new Map<string, SiteNotificationSettings>();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [uid, prefs] of Object.entries(raw).slice(0, 10000)) {
          if (uid && uid !== 'guest' && uid.length <= 128) result.set(uid, normalizeSiteNotificationSettings(prefs));
        }
      }
    }
  } catch (err) {
    console.error('[SiteNotifications] Preferences unavailable: failing closed', err);
  }
  cache = result;
  return result;
}

export function getUserSiteNotificationSettings(uid?: string): SiteNotificationSettings {
  if (!uid || uid === 'guest') return { ...DEFAULT_SITE_NOTIFICATIONS };
  return store().get(uid) ?? { ...DEFAULT_SITE_NOTIFICATIONS };
}
export function saveUserSiteNotificationSettings(uid: string, input: unknown): SiteNotificationSettings {
  if (!uid || uid === 'guest' || uid.length > 128) throw new Error('Неправильний користувач');
  const config = normalizeSiteNotificationSettings(input);
  const copy = new Map(store());
  copy.set(uid, config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(copy)), { mode: 0o600 });
  fs.renameSync(temp, file);
  cache = copy;
  return config;
}

export function categoryForServerEvent(eventType: string, source: string): SiteNotificationKind {
  if (source === 'PRICE_ALERT') return 'price';
  if (source === 'SCREENER') return 'formation';
  const event = String(eventType).toUpperCase();
  if (event.startsWith('DENSITY') || event.includes('ORDERBOOK')) return 'density';
  if (event.startsWith('OI_')) return 'openInterest';
  if (event.includes('BREAKOUT') || event.startsWith('LEVEL_CROSS') || event === 'STRUCTURE_SHIFT'
    || event === 'BOS' || event === 'CHOCH' || event.includes('RETEST')) return 'breakouts';
  if (event.startsWith('FIBONACCI') || event.startsWith('THIRD_TOUCH')) return 'levels';
  if (event === 'IMPULSE' || event === 'MOMENTUM') return 'impulse';
  if (event.startsWith('FORMATION') || event.includes('SETUP')) return 'formation';
  return 'surveillance';
}

export interface ServerNotificationContext {
  source: string;
  eventType: string;
  symbol: string;
  exchange: string;
  marketType: string;
  timeframe?: string;
}
export function isUserNotificationCategoryAllowed(uid: string, params: ServerNotificationContext): boolean {
  const cfg = getUserSiteNotificationSettings(uid);
  return notificationEnabled(cfg, categoryForServerEvent(params.eventType, params.source))
    && matchesNotificationScope(cfg, params);
}
export function isUserTelegramCategoryAllowed(uid: string, params: ServerNotificationContext): boolean {
  const cfg = getUserSiteNotificationSettings(uid);
  return cfg.telegramEnabled && isUserNotificationCategoryAllowed(uid, params);
}
