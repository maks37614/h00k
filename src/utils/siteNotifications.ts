export type SiteNotificationKind = 'price' | 'formation' | 'impulse' | 'surveillance';
export type SiteNotificationSound = 'chime' | 'soft' | 'pulse';
export type ImpulseExchange = 'binance' | 'bybit';
export type ImpulseMarket = 'futures' | 'spot';

export interface SiteNotificationSettings {
  enabled: boolean;
  price: boolean;
  formations: boolean;
  impulses: boolean;
  surveillance: boolean;
  sound: SiteNotificationSound;
  impulseSymbol: string;
  impulseThresholdPct: number;
  impulseWindowMinutes: 1 | 5 | 15;
  impulseExchange: ImpulseExchange;
  impulseMarket: ImpulseMarket;
}

export interface SiteNotificationItem {
  id: string;
  kind: SiteNotificationKind;
  title: string;
  description: string;
  timestamp: number;
  symbol?: string;
  changePct?: number;
  read: boolean;
}

export const DEFAULT_SITE_NOTIFICATIONS: SiteNotificationSettings = {
  enabled: true,
  price: true,
  formations: true,
  impulses: false,
  surveillance: true,
  sound: 'chime',
  impulseSymbol: '',
  impulseThresholdPct: 2,
  impulseWindowMinutes: 5,
  impulseExchange: 'binance',
  impulseMarket: 'futures',
};

export function normalizeImpulseSymbol(input: string): string {
  const symbol = String(input ?? '').trim().toUpperCase().replace(/[/\s-]/g, '');
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) return '';
  return symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
}

export function normalizeSiteNotificationSettings(input: unknown): SiteNotificationSettings {
  const data = input && typeof input === 'object' ? input as Partial<SiteNotificationSettings> : {};
  const threshold = Number(data.impulseThresholdPct);
  return {
    enabled: data.enabled !== false,
    price: data.price !== false,
    formations: data.formations !== false,
    impulses: data.impulses === true,
    surveillance: data.surveillance !== false,
    sound: data.sound === 'soft' || data.sound === 'pulse' ? data.sound : 'chime',
    impulseSymbol: normalizeImpulseSymbol(data.impulseSymbol || ''),
    impulseThresholdPct: Number.isFinite(threshold) ? Math.max(0.1, Math.min(50, Math.round(threshold * 100) / 100)) : 2,
    impulseWindowMinutes: data.impulseWindowMinutes === 1 || data.impulseWindowMinutes === 15 ? data.impulseWindowMinutes : 5,
    impulseExchange: data.impulseExchange === 'bybit' ? 'bybit' : 'binance',
    impulseMarket: data.impulseMarket === 'spot' ? 'spot' : 'futures',
  };
}

export function siteNotificationStorageKey(uid: string): string {
  return 'h00k_site_notifications_v1:' + (uid || 'guest');
}

export function siteNotificationSettingsKey(uid: string): string {
  return 'h00k_site_notification_settings_v1:' + (uid || 'guest');
}

export function notificationEnabled(settings: SiteNotificationSettings, kind: SiteNotificationKind): boolean {
  if (!settings.enabled) return false;
  return kind === 'price' ? settings.price
    : kind === 'formation' ? settings.formations
    : kind === 'impulse' ? settings.impulses
    : settings.surveillance;
}

export function readNotificationItems(raw: string | null): SiteNotificationItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SiteNotificationItem =>
      item && typeof item.id === 'string' && typeof item.title === 'string'
      && typeof item.description === 'string' && Number.isFinite(item.timestamp)
      && ['price', 'formation', 'impulse', 'surveillance'].includes(item.kind)
    ).slice(0, 100).map(item => ({ ...item, read: item.read === true }));
  } catch { return []; }
}

export interface ImpulseDetection {
  changePct: number;
  baselinePrice: number;
  currentPrice: number;
  durationSeconds: number;
}

/** A strictly bounded rolling price window. Uses actual observed trades, not 24h change. */
export class ImpulseTracker {
  private points: Array<{ timestamp: number; price: number }> = [];
  private lastFired = 0;

  constructor(private windowMinutes = 5) {}

  push(price: number, now: number, thresholdPct: number): ImpulseDetection | null {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(now)) return null;
    const windowMs = this.windowMinutes * 60_000;
    const cutoff = now - windowMs;
    this.points = this.points.filter(point => point.timestamp >= cutoff);
    if (!this.points.length || now - this.points[this.points.length - 1].timestamp >= 1000) {
      this.points.push({ timestamp: now, price });
    } else {
      this.points[this.points.length - 1] = { timestamp: now, price };
    }
    if (this.points.length > 1000) this.points.splice(0, this.points.length - 1000);
    const oldest = this.points[0];
    const duration = now - oldest.timestamp;
    if (duration < 10_000 || !Number.isFinite(thresholdPct) || thresholdPct <= 0) return null;
    const change = (price / oldest.price - 1) * 100;
    if (Math.abs(change) + 1e-8 < thresholdPct) return null;
    if (this.lastFired && now - this.lastFired < windowMs) return null;
    this.lastFired = now;
    return {
      changePct: Math.round(change * 100) / 100,
      baselinePrice: oldest.price,
      currentPrice: price,
      durationSeconds: Math.round(duration / 1000),
    };
  }
}
