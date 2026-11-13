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

export const SiteNotificationsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, profile, updateProfileData } = useAuth();
  const { history } = useAlerts();
  const { allEvents, coins: surveillanceCoins } = useSurveillance();
  const { preferences, updatePreferences } = useAppPreferences();
  const uid = user?.uid || 'guest';

  const loadSettings = (id: string, currentProfile: unknown): SiteNotificationSettings => {
    if (currentProfile) return normalizeSiteNotificationSettings(currentProfile);
    try { return normalizeSiteNotificationSettings(JSON.parse(localStorage.getItem(siteNotificationSettingsKey(id)) || 'null')); }
    catch { return { ...DEFAULT_SITE_NOTIFICATIONS }; }
  };
  const [settingsState, setSettingsState] = useState<{ uid: string; settings: SiteNotificationSettings }>(
    () => ({ uid, settings: loadSettings(uid, profile?.siteNotificationSettings) })
  );
  const settings = settingsState.uid === uid ? settingsState.settings
    : loadSettings(uid, profile?.siteNotificationSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [itemState, setItemState] = useState<{ uid: string; items: SiteNotificationItem[] }>(() => ({
    uid, items: readNotificationItems(localStorage.getItem(siteNotificationStorageKey(uid))),
  }));
  const items = itemState.uid === uid ? itemState.items
    : readNotificationItems(localStorage.getItem(siteNotificationStorageKey(uid)));
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const uidRef = useRef(uid);
  uidRef.current = uid;
  const soundEnabledRef = useRef(preferences.soundAlertsEnabled);
  soundEnabledRef.current = preferences.soundAlertsEnabled;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSettingsState({ uid, settings: loadSettings(uid, profile?.siteNotificationSettings) });
    setItemState({ uid, items: readNotificationItems(localStorage.getItem(siteNotificationStorageKey(uid))) });
    setError(null);
  }, [uid]);

  useEffect(() => {
    if (profile?.uid !== uid || typeof profile.soundAlertsEnabled !== 'boolean') return;
    updatePreferences({ soundAlertsEnabled: profile.soundAlertsEnabled });
  }, [uid, profile?.soundAlertsEnabled, updatePreferences]);

  useEffect(() => {
    if (profile?.uid !== uid || !profile.siteNotificationSettings) return;
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
      try { await updateProfileData({ siteNotificationSettings: next }); }
      catch { setError('Не вдалося синхронізувати налаштування з профілем. Вони збережені на цьому пристрої.'); }
    }
  }, [user?.uid, updateProfileData]);

  const setSoundEnabled = useCallback(async (enabled: boolean) => {
    updatePreferences({ soundAlertsEnabled: enabled });
    setError(null);
    if (user?.uid === uidRef.current) {
      try { await updateProfileData({ soundAlertsEnabled: enabled }); }
      catch { setError('Не вдалося зберегти налаштування звуку в профілі.'); }
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

  // Populate existing price and surveillance events without replaying sound.
  useEffect(() => {
    if (uid === 'guest' || !settings.enabled) return;
    const existing = new Set(itemsRef.current.map(item => item.id));
    let clearedAt = 0;
    try { clearedAt = Number(localStorage.getItem(siteNotificationClearedAtKey(uid))) || 0; } catch {}
    const collected: SiteNotificationItem[] = [];
    if (settings.price) for (const h of history.slice(0, 80)) {
      if (h.userId !== uid || !Number.isFinite(h.triggeredAt) || h.triggeredAt <= clearedAt) continue;
      const id = 'price-history:' + h.id;
      if (existing.has(id)) continue;
      existing.add(id);
      collected.push({
        id, kind: 'price', symbol: h.symbol, title: 'Ціновий рівень · ' + h.symbol,
        description: 'Ціна ' + h.triggeredPrice + ' · ціль ' + h.targetPrice + (h.note ? ' · ' + h.note : ''),
        timestamp: h.triggeredAt, read: true,
      });
    }
    const ownedSurveillanceIds = new Set(surveillanceCoins.filter(coin => coin.userId === uid).map(coin => coin.id));
    if (settings.surveillance) for (const event of allEvents.slice(0, 80)) {
      if (!ownedSurveillanceIds.has(event.coinId)) continue;
      if (!Number.isFinite(event.timestamp) || event.timestamp <= clearedAt) continue;
      const id = 'surveillance:' + event.coinId + ':' + event.id;
      if (existing.has(id)) continue;
      existing.add(id);
      collected.push({
        id, kind: 'surveillance', symbol: event.symbol,
        title: event.title || 'Нагляд · ' + event.symbol,
        description: event.description || event.type,
        timestamp: event.timestamp, read: true,
      });
    }
    if (collected.length) {
      replaceItems([...itemsRef.current, ...collected].sort((a, b) => b.timestamp - a.timestamp));
    }
  }, [uid, settings.enabled, settings.price, settings.surveillance, history, allEvents, surveillanceCoins, replaceItems]);

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
      emit({
        id: 'impulse:' + config.impulseExchange + ':' + config.impulseMarket + ':' + symbol + ':' + Date.now(),
        kind: 'impulse', symbol, changePct: outcome.changePct,
        title: (outcome.changePct >= 0 ? '▲ Імпульс зростання · ' : '▼ Імпульс падіння · ') + symbol,
        description: sign + outcome.changePct.toFixed(2) + '% за ' +
          config.impulseWindowMinutes + ' хв (вікно) · ' + config.impulseExchange.toUpperCase()
          + ' · ' + config.impulseMarket,
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
