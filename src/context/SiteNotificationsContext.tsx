import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { useAlerts } from './AlertsContext';
import { useSurveillance } from './SurveillanceContext';
import { useAppPreferences } from '../utils/userPreferences';
import {
  DEFAULT_SITE_NOTIFICATIONS, ImpulseTracker, normalizeSiteNotificationSettings,
  notificationEnabled, readNotificationItems, siteNotificationSettingsKey, siteNotificationStorageKey,
  siteNotificationClearedAtKey,
  type SiteNotificationItem, type SiteNotificationKind, type SiteNotificationSettings, type SiteNotificationSound,
} from '../utils/siteNotifications';
import { playSiteNotificationSound } from '../utils/domSound';

interface NewSiteNotification {
  id: string;
  kind: SiteNotificationKind;
  title: string;
  description: string;
  timestamp?: number;
  symbol?: string;
  changePct?: number;
  rangePct?: number;
}
interface SiteNotificationsValue {
  settings: SiteNotificationSettings;
  updateSettings: (patch: Partial<SiteNotificationSettings>) => Promise<void>;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => Promise<void>;
  items: SiteNotificationItem[];
  unreadCount: number;
  emit: (event: NewSiteNotification) => void;
  markAllRead: () => void;
  clear: () => void;
  error: string | null;
}
const Context = createContext<SiteNotificationsValue | null>(null);

/** Safari privacy modes may disable storage; the notification center must still render. */
function loadStoredItems(uid: string): SiteNotificationItem[] {
  try { return readNotificationItems(localStorage.getItem(siteNotificationStorageKey(uid))); }
  catch { return []; }
}

function soundStorageKey(uid: string): string { return 'h00k_site_notification_sound_v1:' + uid; }
function readStoredSound(uid: string): boolean {
  try { return localStorage.getItem(soundStorageKey(uid)) !== 'false'; } catch { return true; }
}
function changePendingCount(map: Map<string, number>, uid: string, delta: number): void {
  const next = (map.get(uid) || 0) + delta;
  if (next <= 0) map.delete(uid);
  else map.set(uid, next);
}

export const SiteNotificationsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, profile, updateProfileData } = useAuth();
  const { history } = useAlerts();
  const { allEvents, coins: surveillanceCoins, loading: surveillanceLoading } = useSurveillance();
  const { preferences, updatePreferences } = useAppPreferences();
  const uid = user?.uid || 'guest';

  const loadSettings = (id: string, currentProfile: unknown): SiteNotificationSettings => {
    if (currentProfile) return normalizeSiteNotificationSettings(currentProfile);
    try { return normalizeSiteNotificationSettings(JSON.parse(localStorage.getItem(siteNotificationSettingsKey(id)) || 'null')); }
    catch { return { ...DEFAULT_SITE_NOTIFICATIONS }; }
  };
  const [settingsState, setSettingsState] = useState<{ uid: string; settings: SiteNotificationSettings }>(
    () => ({ uid, settings: loadSettings(uid, profile?.uid === uid ? profile.siteNotificationSettings : undefined) })
  );
  const settings = settingsState.uid === uid ? settingsState.settings
    : loadSettings(uid, profile?.uid === uid ? profile.siteNotificationSettings : undefined);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [itemState, setItemState] = useState<{ uid: string; items: SiteNotificationItem[] }>(() => ({
    uid, items: loadStoredItems(uid),
  }));
  const items = itemState.uid === uid ? itemState.items
    : loadStoredItems(uid);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const surveillanceSeen = useRef<{ uid: string; initialized: boolean; ids: Set<string> }>({ uid, initialized: false, ids: new Set() });
  const uidRef = useRef(uid);
  uidRef.current = uid;
  const soundEnabledRef = useRef(preferences.soundAlertsEnabled);
  soundEnabledRef.current = preferences.soundAlertsEnabled;
  const [error, setError] = useState<string | null>(null);
  // Profile snapshots can arrive out of order while toggles are being saved.
  const pendingSettingsWrites = useRef(new Map<string, number>());
  const pendingSoundWrites = useRef(new Map<string, number>());

  useEffect(() => {
    setSettingsState({ uid, settings: loadSettings(uid, profile?.uid === uid ? profile.siteNotificationSettings : undefined) });
    setItemState({ uid, items: loadStoredItems(uid) });
    setError(null);
    const selectedSound = profile?.uid === uid && typeof profile.soundAlertsEnabled === 'boolean'
      ? profile.soundAlertsEnabled : readStoredSound(uid);
    updatePreferences({ soundAlertsEnabled: selectedSound });
  }, [uid, updatePreferences]);

  useEffect(() => {
    if (profile?.uid !== uid || pendingSoundWrites.current.has(uid) || typeof profile.soundAlertsEnabled !== 'boolean') return;
    try { localStorage.setItem(soundStorageKey(uid), String(profile.soundAlertsEnabled)); } catch {}
    updatePreferences({ soundAlertsEnabled: profile.soundAlertsEnabled });
  }, [uid, profile?.soundAlertsEnabled, updatePreferences]);

  useEffect(() => {
    if (profile?.uid !== uid || pendingSettingsWrites.current.has(uid) || !profile.siteNotificationSettings) return;
    const remote = normalizeSiteNotificationSettings(profile.siteNotificationSettings);
    settingsRef.current = remote;
    setSettingsState({ uid, settings: remote });
    try { localStorage.setItem(siteNotificationSettingsKey(uid), JSON.stringify(remote)); } catch {}
  }, [uid, profile?.siteNotificationSettings]);

  const replaceItems = useCallback((next: SiteNotificationItem[]) => {
    const currentUid = uidRef.current;
    const limited = next.slice(0, 100);
    itemsRef.current = limited;
    setItemState({ uid: currentUid, items: limited });
    try { localStorage.setItem(siteNotificationStorageKey(currentUid), JSON.stringify(limited)); } catch {}
  }, []);

  const updateSettings = useCallback(async (patch: Partial<SiteNotificationSettings>) => {
    const currentUid = uidRef.current;
    const next = normalizeSiteNotificationSettings({ ...settingsRef.current, ...patch });
    settingsRef.current = next;
    setSettingsState({ uid: currentUid, settings: next });
    try { localStorage.setItem(siteNotificationSettingsKey(currentUid), JSON.stringify(next)); } catch {}
    setError(null);
    if (user?.uid === currentUid) {
      changePendingCount(pendingSettingsWrites.current, currentUid, 1);
      try { await updateProfileData({ siteNotificationSettings: next }); }
      catch { if (uidRef.current === currentUid) setError('Не вдалося синхронізувати налаштування з профілем. Вони збережені на цьому пристрої.'); }
      finally { changePendingCount(pendingSettingsWrites.current, currentUid, -1); }
    }
  }, [user?.uid, updateProfileData]);

  const setSoundEnabled = useCallback(async (enabled: boolean) => {
    updatePreferences({ soundAlertsEnabled: enabled });
    setError(null);
    const currentUid = uidRef.current;
    try { localStorage.setItem(soundStorageKey(currentUid), String(enabled)); } catch {}
    if (user?.uid === currentUid) {
      changePendingCount(pendingSoundWrites.current, currentUid, 1);
      try { await updateProfileData({ soundAlertsEnabled: enabled }); }
      catch { if (uidRef.current === currentUid) setError('Не вдалося зберегти налаштування звуку в профілі.'); }
      finally { changePendingCount(pendingSoundWrites.current, currentUid, -1); }
    }
  }, [user?.uid, updatePreferences, updateProfileData]);

  const emit = useCallback((event: NewSiteNotification) => {
    if (!notificationEnabled(settingsRef.current, event.kind)) return;
    if (!event.id || !event.title) return;
    if (itemsRef.current.some(item => item.id === event.id)) return;
    const notification: SiteNotificationItem = {
      ...event, timestamp: event.timestamp ?? Date.now(), read: false,
    };
    replaceItems([notification, ...itemsRef.current]);
    if (soundEnabledRef.current) playSiteNotificationSound(settingsRef.current.sound);
    if (typeof document !== 'undefined' && document.hidden
      && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(event.title, { body: event.description, icon: '/favicon.ico' }); } catch {}
    }
  }, [replaceItems]);

  // The server owns actual price-alert delivery. This is a local on-site view only.
  useEffect(() => {
    const onPrice = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (!data || typeof data.symbol !== 'string') return;
      emit({
        id: 'price:' + String(data.alertId || data.symbol + ':' + data.targetPrice + ':' + Date.now()),
        kind: 'price', symbol: data.symbol,
        title: 'Ціновий рівень досягнуто · ' + data.symbol,
        description: String(data.message || 'Рівень ' + data.targetPrice + ' досягнуто'),
      });
    };
    window.addEventListener('signalhook:alert-triggered', onPrice);
    return () => window.removeEventListener('signalhook:alert-triggered', onPrice);
  }, [emit]);

  // Backfill price alerts from server history after login, without sound.
  useEffect(() => {
    if (uid === 'guest' || !settings.enabled || !settings.price) return;
    const existing = new Set(itemsRef.current.map(item => item.id));
    let clearedAt = 0;
    try { clearedAt = Number(localStorage.getItem(siteNotificationClearedAtKey(uid))) || 0; } catch {}
    const collected: SiteNotificationItem[] = [];
    for (const h of history.slice(0, 80)) {
      if (h.userId !== uid || !Number.isFinite(h.triggeredAt) || h.triggeredAt <= clearedAt) continue;
      const id = h.alertId ? 'price:' + h.alertId + ':' + String(h.deliveryEpoch ?? 0) : 'price-history:' + h.id;
      if (existing.has(id)) continue;
      existing.add(id);
      collected.push({
        id, kind: 'price', symbol: h.symbol, title: 'Ціновий рівень · ' + h.symbol,
        description: 'Ціна ' + h.triggeredPrice + ' · ціль ' + h.targetPrice + (h.note ? ' · ' + h.note : ''),
        timestamp: h.triggeredAt, read: true,
      });
    }
    if (collected.length) replaceItems([...itemsRef.current, ...collected].sort((a, b) => b.timestamp - a.timestamp));
  }, [uid, settings.enabled, settings.price, history, replaceItems]);

  // Existing surveillance events are read-only history; only genuinely new events
  // generate a badge and optional sound after the first complete per-user fetch.
  useEffect(() => {
    if (uid === 'guest' || surveillanceLoading) return;
    if (surveillanceSeen.current.uid !== uid) {
      surveillanceSeen.current = { uid, initialized: false, ids: new Set() };
    }
    const owned = new Set(surveillanceCoins.filter(coin => coin.userId === uid).map(coin => coin.id));
    const scoped = allEvents.filter(event => owned.has(event.coinId));
    const previous = surveillanceSeen.current;
    const events = scoped.map(event => ({ event, id: 'surveillance:' + event.coinId + ':' + event.id }));
    if (!previous.initialized) {
      previous.initialized = true;
      for (const { id } of events) previous.ids.add(id);
      if (!settings.enabled || !settings.surveillance) return;
      let clearedAt = 0;
      try { clearedAt = Number(localStorage.getItem(siteNotificationClearedAtKey(uid))) || 0; } catch {}
      const stored = new Set(itemsRef.current.map(item => item.id));
      const old: SiteNotificationItem[] = [];
      for (const { event, id } of events.slice(0, 80)) {
        if (!Number.isFinite(event.timestamp) || event.timestamp <= clearedAt || stored.has(id)) continue;
        stored.add(id);
        old.push({
          id, kind: 'surveillance', symbol: event.symbol,
          title: event.title || 'Нагляд · ' + event.symbol,
          description: event.description || event.type,
          timestamp: event.timestamp, read: true,
        });
      }
      if (old.length) replaceItems([...itemsRef.current, ...old].sort((a, b) => b.timestamp - a.timestamp));
      return;
    }
    for (const { event, id } of events) {
      if (previous.ids.has(id)) continue;
      previous.ids.add(id);
      if (!Number.isFinite(event.timestamp) || Date.now() - event.timestamp > 3 * 60_000) continue;
      emit({
        id, kind: 'surveillance', symbol: event.symbol,
        title: event.title || 'Нагляд · ' + event.symbol,
        description: event.description || event.type,
        timestamp: event.timestamp,
      });
    }
    // Keep the memory bounded with the current recent-events batch.
    if (previous.ids.size > 1000) previous.ids = new Set(events.map(item => item.id));
  }, [uid, allEvents, surveillanceCoins, surveillanceLoading, settings.enabled, settings.surveillance, emit, replaceItems]);

  // One direct WS per selected coin, never a global ticker REST loop.
  useEffect(() => {
    const config = settings;
    if (!config.enabled || !config.impulses || !config.impulseSymbol || typeof WebSocket === 'undefined') return;
    const symbol = config.impulseSymbol;
    const tracker = new ImpulseTracker(config.impulseWindowMinutes);
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let retries = 0;
    let lastProcessedAt = 0;
    const onPrice = (price: number) => {
      const now = Date.now();
      if (now - lastProcessedAt < 400) return;
      lastProcessedAt = now;
      const outcome = tracker.push(price, now, config.impulseThresholdPct);
      if (!outcome) return;
      const sign = outcome.changePct >= 0 ? '+' : '';
      const elapsed = outcome.durationSeconds < 60
        ? outcome.durationSeconds + ' с'
        : (outcome.durationSeconds / 60).toFixed(1) + ' хв';
      emit({
        id: outcome.kind + ':' + config.impulseExchange + ':' + config.impulseMarket + ':' + symbol + ':' + now,
        kind: outcome.kind, symbol,
        changePct: outcome.kind === 'impulse' ? outcome.changePct : undefined,
        rangePct: outcome.kind === 'volatility' ? outcome.rangePct : undefined,
        title: outcome.kind === 'volatility'
          ? '≈ Сплеск волатильності · ' + symbol
          : (outcome.changePct >= 0 ? '▲ Імпульс зростання · ' : '▼ Імпульс падіння · ') + symbol,
        description: (outcome.kind === 'volatility'
          ? 'Діапазон коливань ' + outcome.rangePct.toFixed(2) + '%'
          : sign + outcome.changePct.toFixed(2) + '%')
          + ' за ' + elapsed + ' (вікно ' + config.impulseWindowMinutes + ' хв) · '
          + config.impulseExchange.toUpperCase() + ' · ' + config.impulseMarket,
      });
    };
    const connect = () => {
      if (stopped) return;
      const isBinance = config.impulseExchange === 'binance';
      const url = isBinance
        ? (config.impulseMarket === 'futures' ? 'wss://fstream.binance.com/ws/' : 'wss://stream.binance.com:9443/ws/')
          + symbol.toLowerCase() + '@aggTrade'
        : 'wss://stream.bybit.com/v5/public/' + (config.impulseMarket === 'futures' ? 'linear' : 'spot');
      try {
        socket = new WebSocket(url);
        socket.onopen = () => {
          retries = 0;
          if (!isBinance) {
            socket?.send(JSON.stringify({ op: 'subscribe', args: ['publicTrade.' + symbol] }));
            heartbeat = setInterval(() => {
              if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 'ping' }));
            }, 20_000);
          }
        };
        socket.onmessage = (message) => {
          try {
            const packet = JSON.parse(String(message.data));
            if (isBinance) {
              if (packet.e === 'aggTrade') onPrice(Number(packet.p));
            } else if (packet.topic === 'publicTrade.' + symbol && Array.isArray(packet.data)) {
              const latest = packet.data[packet.data.length - 1];
              if (latest) onPrice(Number(latest.p));
            }
          } catch { /* Ignore control frames and malformed updates. */ }
        };
        socket.onclose = () => {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
          if (!stopped) reconnect = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(retries++, 5)));
        };
        socket.onerror = () => socket?.close();
      } catch {
        if (!stopped) reconnect = setTimeout(connect, 10_000);
      }
    };
    connect();
    return () => {
      stopped = true;
      if (reconnect) clearTimeout(reconnect);
      if (heartbeat) clearInterval(heartbeat);
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.close();
      }
    };
  }, [uid, settings.enabled, settings.impulses, settings.impulseSymbol,
    settings.impulseExchange, settings.impulseMarket, settings.impulseWindowMinutes,
    settings.impulseThresholdPct, emit]);

  const markAllRead = useCallback(() => replaceItems(itemsRef.current.map(item => ({ ...item, read: true }))), [replaceItems]);
  const clear = useCallback(() => {
    try { localStorage.setItem(siteNotificationClearedAtKey(uidRef.current), String(Date.now())); } catch {}
    replaceItems([]);
  }, [replaceItems]);
  const unreadCount = items.filter(item => !item.read).length;

  return <Context.Provider value={{
    settings, updateSettings, soundEnabled: preferences.soundAlertsEnabled, setSoundEnabled,
    items, unreadCount, emit, markAllRead, clear, error,
  }}>{children}</Context.Provider>;
};

export function useOptionalSiteNotifications(): SiteNotificationsValue | null {
  return useContext(Context);
}

export function useSiteNotifications(): SiteNotificationsValue {
  const value = useContext(Context);
  if (!value) throw new Error('useSiteNotifications requires SiteNotificationsProvider');
  return value;
}
