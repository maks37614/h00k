import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { InstallAppButton } from './components/InstallAppButton';
import { Header } from './components/Header';
import { SiteFooter } from './components/SiteFooter';
import { ScreenerIcon, FormationsIcon, TerminalIcon } from './components/PageIcons';
import { ScreenerFilters } from './components/ScreenerFilters';
import { FormationCard } from './components/FormationCard';
import { EarlyFormationsResults } from './components/EarlyFormationsResults';
import { earlyFormationChartMarkers, type EarlyFormationCandidate } from './utils/earlyFormations';
import { createEarlyModeFilters, findCurrentEarlyFormation, getVisibleEarlyFormations, type EarlyStageFilter } from './utils/earlyFormationList';
import { ScreenerTable } from './components/ScreenerTable';
import { CoinScreenerPage } from './components/CoinScreenerPage';
import { TerminalPage } from './components/TerminalPage';
import { SurveillancePage } from './components/SurveillancePage';
import { ReplayPage } from './components/ReplayPage';
import { FormationDetailsModal } from './components/FormationDetailsModal';
import { FullscreenChartModal } from './components/FullscreenChartModal';
import { FormationGuideModal } from './components/FormationGuideModal';
import { WatchlistDrawer } from './components/WatchlistDrawer';
import { MetaScalpModal } from './components/MetaScalpModal';
import { MetaScalpToast, MetaScalpToastState } from './components/MetaScalpToast';
import { TelegramAlertsModal } from './components/TelegramAlertsModal';
import { AuthModal, AuthPromptReason } from './components/AuthModal';
import { UserProfileModal } from './components/UserProfileModal';
import { ArchiveModal } from './components/ArchiveModal';
import { AlertToast, AlertToastState } from './components/AlertToast';
import { useAlerts } from './context/AlertsContext';
import { useAuth } from './context/AuthContext';
import { useArchive } from './context/ArchiveContext';
import { useSurveillance } from './context/SurveillanceContext';
import { useLanguage } from './context/LanguageContext';
import {
  MetaScalpSettings,
  getUserMetaScalpSettings,
  saveStoredMetaScalpSettings,
  sendTickerToMetaScalp,
} from './utils/metaScalpService';
import { ScannedCoin, DetectedFormation, ScreenerFilterState, PriceAlert, ArchivedFormation, ActivePageType, type FullEarlyScanSnapshot } from './types';
import { runDirectClientScan, getFallbackScannedCoins, hydrateMissingRegularOIFromBrowser } from './utils/directExchangeClient';
import { getVisibleFormations, groupVisibleFormations } from './utils/formationList';
import { getTpSlRule, normalizeTpSlSettings, projectUserCoins, resolveEarlyTpSl, resolveFormationTpSl } from './utils/tpSlConstructor';
import { countActiveRegularIndicatorFilters, DEFAULT_REGULAR_INDICATOR_FILTERS, type RegularIndicatorFilters } from './utils/regularFormationIndicators';
import { resolveWatchlistEntries } from './utils/watchlistUtils';
import {
  AlertCircle,
  RefreshCw,
  Sparkles,
  Lock,
  Key,
  Send,
  ShieldAlert,
  Zap,
  ExternalLink,
  ShieldCheck,
  Sliders,
  CheckCircle2,
} from 'lucide-react';
import { AUTHOR_TELEGRAM_CHANNEL_URL, AUTHOR_TELEGRAM_USERNAME } from './utils/accessCodes';
import { getStoredPreferences, useAppPreferences } from './utils/userPreferences';

const DEFAULT_FILTERS: ScreenerFilterState = {
  exchange: 'binance',
  marketType: 'futures',
  timeframe: '15m',
  category: 'all',
  bias: 'all',
  status: 'all',
  minVolumeUsd: 0,
  densityConfirmedOnly: false,
  searchQuery: '',
  sortBy: 'confidence',
  sortOrder: 'desc',
};

export default function App() {
  const { preferences } = useAppPreferences();
  const { t } = useLanguage();
  const [coins, setCoins] = useState<ScannedCoin[]>(() => getFallbackScannedCoins());
  const scanRequestRef = useRef(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ScreenerFilterState>(() => {
    const prefs = getStoredPreferences();
    return {
      ...DEFAULT_FILTERS,
      exchange: prefs.defaultExchange,
      marketType: prefs.defaultMarketType,
      timeframe: prefs.defaultTimeframe,
    };
  });
  // Keep ordinary screener preferences and the early W/M controls independent.
  // First early activation inherits the active market, timeframe and search,
  // but hidden regular-only filters do not suppress early candidates.
  // These independent technical filters affect only ordinary formations.
  const [regularIndicatorFilters, setRegularIndicatorFilters] = useState<RegularIndicatorFilters>({
    ...DEFAULT_REGULAR_INDICATOR_FILTERS,
  });
  const [earlyFilters, setEarlyFilters] = useState<ScreenerFilterState>(() => createEarlyModeFilters(filters));
  const [earlyStage, setEarlyStage] = useState<EarlyStageFilter>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  useEffect(() => {
    setFilters((prev) => {
      if (
        prev.exchange === preferences.defaultExchange &&
        prev.marketType === preferences.defaultMarketType &&
        prev.timeframe === preferences.defaultTimeframe
      ) {
        return prev;
      }
      return {
        ...prev,
        exchange: preferences.defaultExchange,
        marketType: preferences.defaultMarketType,
        timeframe: preferences.defaultTimeframe,
      };
    });
  }, [preferences.defaultExchange, preferences.defaultMarketType, preferences.defaultTimeframe]);

  // Auth & Profile
  const { user, profile, loading: authLoading, updateProfileData } = useAuth();
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [authPromptReason, setAuthPromptReason] = useState<AuthPromptReason>(null);
  const [authInitialMode, setAuthInitialMode] = useState<'signin' | 'signup'>('signin');
  const [earlyMode, setEarlyMode] = useState(false);
  useEffect(() => {
    try {
      setEarlyMode(localStorage.getItem('h00k-early-formations:' + (user?.uid || 'guest')) === '1');
    } catch { setEarlyMode(false); }
  }, [user?.uid]);
  const changeEarlyMode = (enabled: boolean) => {
    setEarlyMode(enabled);
    try { localStorage.setItem('h00k-early-formations:' + (user?.uid || 'guest'), enabled ? '1' : '0'); } catch {}
  };

  const [fullEarlyScan, setFullEarlyScan] = useState<FullEarlyScanSnapshot | null>(null);
  const [earlyRefreshNonce, setEarlyRefreshNonce] = useState(0);
  const refreshFullEarlyScan = useCallback(() => setEarlyRefreshNonce(value => value + 1), []);
  const stopEarlyScanRef = useRef<(() => Promise<void>) | null>(null);
  const stopFullEarlyScan = useCallback(() => {
    void stopEarlyScanRef.current?.();
  }, []);

  // Run only on demand while early detection is enabled. The server shares a
  // bounded full-market job among clients and reports incremental progress;
  // browser fallback also checks every exchange ticker, in throttled batches.
  useEffect(() => {
    if (!earlyMode) {
      setFullEarlyScan(null);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    let stopRequested = false;
    let browserFallbackActive = false;
    let activeServerId: string | null = null;
    let stopRequest: Promise<void> | null = null;
    const initial: FullEarlyScanSnapshot = {
      id: '', status: 'loading', total: 0, processed: 0, checked: 0,
      skipped: 0, failed: 0, startedAt: Date.now(), updatedAt: Date.now(),
      missingSources: [], data: [],
    };
    setFullEarlyScan(initial);

    const stopServer = (id: string): Promise<void> => {
      if (stopRequest) return stopRequest;
      stopRequest = (async () => {
        try {
          const response = await fetch('/api/screener/early/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          if (!response.ok) throw new Error('Не вдалося зупинити серверний пошук');
          const result = await response.json();
          if (!result.success || !result.scan) throw new Error('Не отримано підтвердження зупинки');
          if (alive) setFullEarlyScan(result.scan as FullEarlyScanSnapshot);
        } catch {
          stopRequested = false;
          stopRequest = null;
          if (alive) setFullEarlyScan(previous => ({
            ...(previous ?? initial),
            status: 'running',
            message: 'Не вдалося надіслати команду зупинки. Спробуйте ще раз.',
          }));
        }
      })();
      return stopRequest;
    };

    const stopScan = async () => {
      if (!alive || stopRequested) return;
      stopRequested = true;
      if (browserFallbackActive) {
        controller.abort();
        setFullEarlyScan(previous => ({
          ...(previous ?? initial), status: 'stopped', finishedAt: Date.now(),
          updatedAt: Date.now(),
          message: 'Пошук зупинено. Уже знайдені формації збережено.',
        }));
        return;
      }
      setFullEarlyScan(previous => ({
        ...(previous ?? initial), status: 'stopping',
        message: 'Зупиняємо пошук після поточного пакета…',
      }));
      if (activeServerId) await stopServer(activeServerId);
    };
    stopEarlyScanRef.current = stopScan;

    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const currentParams = {
      exchange: earlyFilters.exchange,
      marketType: earlyFilters.marketType,
      timeframe: earlyFilters.timeframe,
      minVolumeUsd: earlyFilters.minVolumeUsd,
    };

    const browserFallback = async () => {
      browserFallbackActive = true;
      const startedAt = Date.now();
      const data = await runDirectClientScan(currentParams, {
        completeEarly: true,
        signal: controller.signal,
        onProgress: progress => {
          if (!alive || stopRequested) return;
          const checked = Math.max(0, progress.processed - progress.failed - progress.skipped);
          setFullEarlyScan({
            id: 'browser', status: 'running',
            ...progress, checked, startedAt, updatedAt: Date.now(),
          });
        },
      });
      if (!alive || stopRequested) return;
      setFullEarlyScan(previous => ({
        ...(previous ?? initial),
        status: previous?.failed || previous?.missingSources.length ? 'partial' : 'completed',
        data, finishedAt: Date.now(), updatedAt: Date.now(),
      }));
    };

    const start = async () => {
      let shouldFallback = false;
      let startedServerJob = false;
      try {
        let response: Response | null = null;
        while (alive && !controller.signal.aborted && !stopRequested) {
          response = await fetch('/api/screener/early/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...currentParams, force: earlyRefreshNonce > 0 }),
            signal: controller.signal,
          });
          if (response.status !== 429) break;
          if (alive) setFullEarlyScan(previous => ({
            ...(previous ?? initial), message: 'Інше повне сканування триває. Очікування вільного слота…',
          }));
          await sleep(5000);
        }
        if (!alive || controller.signal.aborted) return;
        if (stopRequested && (!response || response.status === 429)) {
          setFullEarlyScan(previous => ({
            ...(previous ?? initial), status: 'stopped', finishedAt: Date.now(),
            message: 'Пошук зупинено до початку перевірки свічок.',
          }));
          return;
        }
        if (!response || !response.ok) throw new Error('Сервер повного сканування недоступний');
        const startJson = await response.json();
        if (!startJson.success || !startJson.scan?.id) throw new Error('Сервер не повернув ID сканування');
        startedServerJob = true;
        let snapshot = startJson.scan as FullEarlyScanSnapshot;
        activeServerId = snapshot.id;
        if (stopRequested) {
          await stopServer(snapshot.id);
        } else {
          setFullEarlyScan(snapshot);
        }
        while (alive && ['loading', 'running', 'stopping'].includes(snapshot.status)) {
          await sleep(1500);
          if (!alive || controller.signal.aborted) return;
          const statusResponse = await fetch(
            '/api/screener/early/status?id=' + encodeURIComponent(snapshot.id),
            { signal: controller.signal },
          );
          if (!statusResponse.ok) throw new Error('Втрачено зв’язок із сервером сканування');
          const update = await statusResponse.json();
          if (!update.success || !update.scan) throw new Error('Пошук не повернув прогрес');
          snapshot = update.scan as FullEarlyScanSnapshot;
          if (alive) setFullEarlyScan(snapshot);
        }
        if (!stopRequested && snapshot.status === 'failed' && snapshot.processed === 0) shouldFallback = true;
      } catch (error) {
        if (!alive || controller.signal.aborted) return;
        if (stopRequested) {
          setFullEarlyScan(previous => ({
            ...(previous ?? initial), status: 'stopped', finishedAt: Date.now(),
            message: 'Зупинено. Якщо сервер уже отримав запит, він може завершити поточну операцію.',
          }));
          return;
        }
        if (startedServerJob) {
          // A transient polling error must never launch a second multi-thousand-
          // request browser scan while the server job may still be running.
          setFullEarlyScan(previous => ({
            ...(previous ?? initial), status: 'partial', finishedAt: Date.now(),
            message: 'Зв’язок із поточним серверним скануванням втрачено. Оновіть пошук, щоб відновити перевірку.',
          }));
          return;
        }
        shouldFallback = true;
      }
      if (shouldFallback && alive && !stopRequested && !controller.signal.aborted) {
        try {
          setFullEarlyScan({ ...initial, message: 'Сервер недоступний. Повна перевірка через браузер…' });
          await browserFallback();
        } catch (error) {
          if (alive && !controller.signal.aborted) {
            setFullEarlyScan(previous => ({
              ...(previous ?? initial), status: 'failed', finishedAt: Date.now(),
              message: error instanceof Error ? error.message : 'Повний пошук недоступний.',
            }));
          }
        }
      }
    };
    void start();
    return () => {
      alive = false;
      controller.abort();
      if (stopEarlyScanRef.current === stopScan) stopEarlyScanRef.current = null;
    };
  }, [earlyMode, earlyFilters.exchange, earlyFilters.marketType, earlyFilters.timeframe,
    earlyFilters.minVolumeUsd, earlyRefreshNonce]);

  // Refresh a completed scan at a lower cadence; never restart or reset a
  // still-running exhaustive sweep, which can span many exchange API batches.
  useEffect(() => {
    if (!earlyMode || !fullEarlyScan
      || !['completed', 'partial', 'failed'].includes(fullEarlyScan.status)) return;
    const timer = setTimeout(refreshFullEarlyScan, 5 * 60_000);
    return () => clearTimeout(timer);
  }, [earlyMode, fullEarlyScan?.status, fullEarlyScan?.finishedAt, refreshFullEarlyScan]);

  const handleOpenAuthModal = useCallback((mode: 'signin' | 'signup' = 'signin', reason: AuthPromptReason = null) => {
    setAuthInitialMode(mode);
    setAuthPromptReason(reason);
    setIsAuthModalOpen(true);
  }, []);

  // Active Category: 'patterns' | 'screener' | 'terminal' | 'surveillance'
  // Default main page of the site is always 'screener'
  const [activePage, setActivePage] = useState<ActivePageType>('screener');

  // Enforce access control and hash sync
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      if (hash === '#replay') {
        setActivePage((prev) => (prev === 'replay' ? prev : 'replay'));
        return;
      }
      if (!user) {
        setActivePage((prev) => (prev === 'screener' ? prev : 'screener'));
        if (hash && hash !== '#screener' && hash !== '') {
          handleOpenAuthModal('signin', 'general');
          window.location.hash = 'screener';
        }
        return;
      }
      if (hash === '#patterns') {
        setActivePage((prev) => (prev === 'patterns' ? prev : 'patterns'));
      } else if (hash === '#terminal') {
        setActivePage((prev) => (prev === 'terminal' ? prev : 'terminal'));
      } else if (hash === '#surveillance') {
        setActivePage((prev) => (prev === 'surveillance' ? prev : 'surveillance'));
      } else if (hash === '#replay') {
        setActivePage((prev) => (prev === 'replay' ? prev : 'replay'));
      } else {
        // default / root / #screener
        setActivePage((prev) => (prev === 'screener' ? prev : 'screener'));
      }
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [user?.uid, handleOpenAuthModal]);

  const handlePageChange = (page: ActivePageType) => {
    if (!user && page !== 'screener' && page !== 'replay') {
      handleOpenAuthModal('signin', 'general');
      return;
    }
    setActivePage(page);
    if (typeof window !== 'undefined') {
      window.location.hash = page;
    }
  };

  const { activeCount: surveillanceActiveCount } = useSurveillance();

  // Watchlist stored per user (isolated)
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [watchlistFolders, setWatchlistFolders] = useState<Record<string, string[]>>({});
  const watchlistCount = useMemo(() => resolveWatchlistEntries(watchlist, coins).length, [watchlist, coins]);

  // Synchronize watchlist with current logged-in user profile & user-scoped storage (strictly isolated, guests see 0)
  useEffect(() => {
    if (!user) {
      setWatchlist((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    if (profile?.watchlist && Array.isArray(profile.watchlist)) {
      setWatchlist((prev) => {
        const next = Array.from(new Set(profile.watchlist));
        if (prev.length === next.length && prev.every((item, i) => item === next[i])) {
          return prev;
        }
        try {
          localStorage.setItem(`crypto_screener_watchlist_${user.uid}`, JSON.stringify(next));
        } catch {}
        return next;
      });
      return;
    }

    try {
      const userKey = `crypto_screener_watchlist_${user.uid}`;
      const saved = localStorage.getItem(userKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setWatchlist((prev) => {
            const next = Array.from(new Set(parsed));
            if (prev.length === next.length && prev.every((item, i) => item === next[i])) {
              return prev;
            }
            return next;
          });
          return;
        }
      }
    } catch {}

    setWatchlist((prev) => (prev.length === 0 ? prev : []));
  }, [user?.uid, profile?.watchlist]);

  useEffect(() => {
    if (!user) {
      setWatchlistFolders((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }

    const folders = profile?.watchlistFolders;
    if (folders && typeof folders === 'object') {
      setWatchlistFolders((prev) => {
        if (JSON.stringify(prev) === JSON.stringify(folders)) {
          return prev;
        }
        return folders;
      });
      return;
    }

    try {
      const saved = localStorage.getItem(`crypto_screener_watchlist_folders_${user.uid}`);
      const parsed = saved ? JSON.parse(saved) : {};
      setWatchlistFolders((prev) => {
        if (JSON.stringify(prev) === JSON.stringify(parsed)) {
          return prev;
        }
        return parsed;
      });
    } catch {
      setWatchlistFolders((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    }
  }, [user?.uid, profile?.watchlistFolders]);

  // Sound enabled
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    const prefs = getStoredPreferences();
    return prefs.soundAlertsEnabled;
  });

  useEffect(() => {
    setSoundEnabled((prev) => (prev === preferences.soundAlertsEnabled ? prev : preferences.soundAlertsEnabled));
  }, [preferences.soundAlertsEnabled]);

  const [selectedPair, setSelectedPair] = useState<{
    coin: ScannedCoin;
    formation?: DetectedFormation;
  } | null>(null);

  const [isWatchlistOpen, setIsWatchlistOpen] = useState<boolean>(false);
  const [isGuideOpen, setIsGuideOpen] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  // MetaScalp terminal settings state (isolated per user)
  const [isLinkingModalOpen, setIsLinkingModalOpen] = useState<boolean>(false);
  const [metaScalpToast, setMetaScalpToast] = useState<MetaScalpToastState | null>(null);
  const metaScalpUserIdRef = useRef(user?.uid);
  const [metaScalpSettingsState, setMetaScalpSettingsState] = useState<{
    userId: string | undefined;
    settings: MetaScalpSettings;
  }>(() => ({ userId: user?.uid, settings: getUserMetaScalpSettings(user?.uid, profile) }));
  const metaScalpSettings = metaScalpSettingsState.userId === user?.uid
    ? metaScalpSettingsState.settings
    : getUserMetaScalpSettings(user?.uid, profile);

  useEffect(() => {
    const next = getUserMetaScalpSettings(user?.uid, profile);
    setMetaScalpSettingsState((prev) => {
      if (
        prev.userId === user?.uid &&
        prev.settings.enabled === next.enabled &&
        prev.settings.port === next.port &&
        prev.settings.binding === next.binding &&
        prev.settings.autoSwitchOnClick === next.autoSwitchOnClick &&
        prev.settings.soundFeedback === next.soundFeedback
      ) return prev;
      return { userId: user?.uid, settings: next };
    });
  }, [user?.uid, profile?.uid, profile?.metaScalpSettings]);

  useLayoutEffect(() => {
    metaScalpUserIdRef.current = user?.uid;
    setIsLinkingModalOpen(false);
    setMetaScalpToast(null);
  }, [user?.uid]);

  const handleMetaScalpSettingsChange = useCallback((newSettings: MetaScalpSettings) => {
    if (!user || metaScalpUserIdRef.current !== user.uid) return;
    setMetaScalpSettingsState({ userId: user.uid, settings: newSettings });
    saveStoredMetaScalpSettings(newSettings, user.uid);
    updateProfileData({ metaScalpSettings: newSettings }).catch(() => {});
  }, [user, updateProfileData]);

  // Telegram price alerts state
  const { activeAlertsCount } = useAlerts();
  const [isTelegramModalOpen, setIsTelegramModalOpen] = useState<boolean>(false);
  const [telegramPrefill, setTelegramPrefill] = useState<any>(null);
  const [alertToast, setAlertToast] = useState<AlertToastState | null>(null);

  // Formations Archive state
  const { archivedFormations } = useArchive();
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState<boolean>(false);
  const [selectedArchivedItem, setSelectedArchivedItem] = useState<ArchivedFormation | null>(null);

  // Authentication & Profile modals
  const [isProfileModalOpen, setIsProfileModalOpen] = useState<boolean>(false);

  // Auto-dismiss Alert toast
  useEffect(() => {
    if (alertToast) {
      const timer = setTimeout(() => {
        setAlertToast(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [alertToast]);

  // Listen for background alert triggered events from AlertsContext CRON
  useEffect(() => {
    const handleTriggered = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent?.detail) {
        setAlertToast({
          id: Date.now(),
          symbol: customEvent.detail.symbol,
          targetPrice: customEvent.detail.targetPrice,
          condition: customEvent.detail.condition,
          message: customEvent.detail.message || 'Цільову ціну досягнуто!',
        });
      }
    };

    window.addEventListener('signalhook:alert-triggered', handleTriggered);
    return () => window.removeEventListener('signalhook:alert-triggered', handleTriggered);
  }, []);

  const handleOpenTelegramAlerts = useCallback((prefill?: any) => {
    if (!user) {
      handleOpenAuthModal('signin', 'alerts');
      return;
    }
    setTelegramPrefill(prefill || null);
    setIsTelegramModalOpen(true);
  }, [user, handleOpenAuthModal]);

  const handleAlertToast = useCallback(
    (toast: { symbol: string; targetPrice: number; condition: 'gte' | 'lte'; message?: string }) => {
      setAlertToast({
        id: Date.now(),
        symbol: toast.symbol,
        targetPrice: toast.targetPrice,
        condition: toast.condition,
        message: toast.message,
      });
    },
    []
  );

  // Auto-dismiss MetaScalp toast
  useEffect(() => {
    if (metaScalpToast) {
      const timer = setTimeout(() => {
        setMetaScalpToast(null);
      }, 3500);
      return () => clearTimeout(timer);
    }
  }, [metaScalpToast]);

  // Send ticker to MetaScalp terminal
  const handleSendToMetaScalp = useCallback(
    async (coin: ScannedCoin) => {
      if (!user) {
        handleOpenAuthModal('signin', 'linking');
        return;
      }

      if (!metaScalpSettings.enabled) {
        setIsLinkingModalOpen(true);
        return;
      }

      const res = await sendTickerToMetaScalp(
        coin.symbol,
        coin.exchange,
        coin.marketType,
        metaScalpSettings
      );
      if (metaScalpUserIdRef.current !== user.uid) return;

      if (res.success) {
        setMetaScalpToast({
          id: Date.now(),
          type: 'success',
          title: 'MetaScalp Оновлено',
          ticker: res.ticker,
          binding: res.binding,
          message: res.message,
        });
      } else {
        setMetaScalpToast({
          id: Date.now(),
          type: 'warning',
          title: 'MetaScalp',
          ticker: res.ticker,
          binding: res.binding,
          message: res.copiedToClipboard
            ? `${res.message} (Тікер скопійовано у буфер: Ctrl+V)`
            : res.message,
        });
      }
    },
    [user, metaScalpSettings, handleOpenAuthModal]
  );

  // Handler when selecting pair for details modal
  const handleSelectPair = useCallback(
    (coin: ScannedCoin, formation?: DetectedFormation) => {
      if (!user) {
        handleOpenAuthModal('signin', 'chart');
        return;
      }
      // Store RAW source levels. Applying a user profile projection to an already
      // projected card would multiply ATR offsets when the profile changes.
      const rawCoin = coins.find(row =>
        row.symbol === coin.symbol && row.exchange === coin.exchange &&
        row.marketType === coin.marketType && row.timeframe === coin.timeframe);
      const chosen = formation || coin.formations[0];
      const rawFormation = rawCoin?.formations.find(item => item.id === chosen?.id) ?? chosen;
      setSelectedArchivedItem(null);
      setSelectedPair({ coin: rawCoin ?? coin, formation: rawFormation });
      const shouldAutoSwitch =
        metaScalpSettings.enabled && metaScalpSettings.autoSwitchOnClick;

      if (shouldAutoSwitch) {
        handleSendToMetaScalp(coin);
      }
    },
    [user, coins, metaScalpSettings, handleSendToMetaScalp, handleOpenAuthModal]
  );

  const [selectedEarly, setSelectedEarly] = useState<{ coin: ScannedCoin; candidate: EarlyFormationCandidate } | null>(null);
  // A's chart and projected trade levels must never remain open for user B
  // after switching accounts on the same browser.
  const detailAccountRef = useRef(user?.uid ?? null);
  useEffect(() => {
    const uid = user?.uid ?? null;
    if (detailAccountRef.current === uid) return;
    detailAccountRef.current = uid;
    setSelectedEarly(null);
    setSelectedPair(null);
    setSelectedArchivedItem(null);
  }, [user?.uid]);
  // A projected setup is valid only while the latest scan still contains its exact
  // instrument, timeframe and structure. Recalculate its levels on each refresh;
  // close the old preview immediately when the setup disappears or invalidates.
  useEffect(() => {
    if (!selectedEarly) return;
    const current = findCurrentEarlyFormation(selectedEarly, earlyMode ? (fullEarlyScan?.data ?? []) : coins);
    if (!current) {
      setSelectedEarly(null);
    } else if (current.coin !== selectedEarly.coin || current.candidate !== selectedEarly.candidate) {
      setSelectedEarly(current);
    }
  }, [coins, earlyMode, fullEarlyScan?.data, selectedEarly]);

  const handleOpenEarly = useCallback((coin: ScannedCoin, candidate: EarlyFormationCandidate) => {
    if (!user) { handleOpenAuthModal('signin', 'chart'); return; }
    // Cards show a PERSONAL projection, but details must start from the RAW
    // shared scan candidate; otherwise the ATR offset is applied twice.
    const raw = findCurrentEarlyFormation({ coin, candidate }, fullEarlyScan?.data ?? []);
    if (!raw) return; // Stale candidate: do not reopen an invalidated scenario.
    setSelectedPair(null);
    setSelectedEarly(raw);
  }, [user, handleOpenAuthModal, fullEarlyScan?.data]);

  // Handler when selecting archived formation to restore
  const handleSelectArchivedFormation = useCallback(
    (archived: ArchivedFormation) => {
      const foundCoin = coins.find(
        (c) => c.symbol === archived.symbol && c.exchange === archived.exchange
      );
      const matchingCoin: ScannedCoin = foundCoin || {
        symbol: archived.symbol,
        baseAsset: archived.baseAsset,
        quoteAsset: archived.quoteAsset,
        exchange: archived.exchange,
        marketType: archived.marketType,
        currentPrice: archived.savedPrice,
        priceChange24h: 0,
        volume24hUsd: 0,
        highPrice24h: archived.savedPrice,
        lowPrice24h: archived.savedPrice,
        high24h: archived.savedPrice,
        low24h: archived.savedPrice,
        timeframe: archived.timeframe,
        formations: [archived.formation],
        hasFormations: true,
        bestFormation: archived.formation,
        exchangeUrl:
          archived.exchange === 'binance'
            ? `https://www.binance.com/uk-UA/trade/${archived.baseAsset}_${archived.quoteAsset}`
            : `https://www.bybit.com/trade/usdt/${archived.baseAsset}USDT`,
        lastUpdated: archived.savedAtTimestamp,
      };

      setSelectedArchivedItem(archived);
      setSelectedPair({
        coin: matchingCoin,
        formation: archived.formation,
      });
      setIsArchiveModalOpen(false);
      const shouldAutoSwitch =
        metaScalpSettings.enabled && metaScalpSettings.autoSwitchOnClick;

      if (shouldAutoSwitch) {
        handleSendToMetaScalp(matchingCoin);
      }
    },
    [coins, metaScalpSettings, handleSendToMetaScalp]
  );

  // Play a gentle alert tone using Web Audio API
  const playAlertSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15); // A5

      gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
    } catch (e) {
      console.warn('Audio playback not permitted yet:', e);
    }
  }, [soundEnabled]);

  // Fetch screener data from API
  const fetchScreenerData = useCallback(async (currentTf = filters.timeframe, currentExchange = filters.exchange, currentMarket = filters.marketType) => {
    const requestId = ++scanRequestRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        timeframe: currentTf,
        exchange: currentExchange,
        marketType: currentMarket,
        minVolume: '0',
      });

      let dataLoaded = false;
      try {
        const res = await fetch(`/api/screener/scan?${params.toString()}`);
        if (res.ok) {
          const contentType = res.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const data = await res.json();
            if (data.success && Array.isArray(data.data) && data.data.length > 0) {
              if (requestId !== scanRequestRef.current) return;
              setCoins(data.data);
              setLastUpdated(Date.now());
              dataLoaded = true;

              const hasHighConfidence = data.data.some((c: ScannedCoin) =>
                c.formations.some((f) => f.confidence >= 88)
              );
              if (hasHighConfidence) {
                playAlertSound();
              }
              // A server scan can succeed while the server's public IP is
              // blocked from futures OI. Refresh ONLY the missing regular OI
              // directly from the browser; do not rescan or change Entry/SL/TP.
              // It re-scores the corresponding quality components safely.
              const supplemented = await hydrateMissingRegularOIFromBrowser(data.data as ScannedCoin[]);
              if (supplemented !== data.data && requestId === scanRequestRef.current) {
                setCoins(supplemented);
              }
            }
          }
        }
      } catch (backendErr) {
        console.warn('Backend scan failed, trying direct exchange access:', backendErr);
      }

      // If backend did not yield data (e.g. an upstream network failure), fall back to direct browser connection
      if (!dataLoaded) {
        const directCoins = await runDirectClientScan({
          exchange: currentExchange,
          marketType: currentMarket,
          timeframe: currentTf,
        });
        if (directCoins.length > 0) {
          if (requestId !== scanRequestRef.current) return;
          setCoins(directCoins);
          setLastUpdated(Date.now());
          dataLoaded = true;
        }
      }
    } catch (err: any) {
      console.warn('Scan complete fallback error:', err);
    } finally {
      if (requestId === scanRequestRef.current) setIsLoading(false);
    }
  }, [filters.timeframe, filters.exchange, filters.marketType, filters.minVolumeUsd, playAlertSound]);

  // The full early scan has its own throttled job. Avoid running the 75-pair
  // standard scan every minute at the same time and competing for exchange quota.
  useEffect(() => {
    if (earlyMode && activePage === 'screener') return;
    fetchScreenerData(filters.timeframe, filters.exchange, filters.marketType);
  }, [earlyMode, activePage, filters.timeframe, filters.exchange, filters.marketType, filters.minVolumeUsd]);

  // Lightweight screener refresh remains unchanged outside full W/M mode.
  useEffect(() => {
    if (earlyMode && activePage === 'screener') return;
    const interval = setInterval(() => {
      fetchScreenerData();
    }, 60000);
    return () => clearInterval(interval);
  }, [earlyMode, activePage, fetchScreenerData]);

  // Toggle watchlist (isolated per user profile or local guest storage)
  const handleToggleWatchlist = (symbol: string) => {
    if (!user) {
      setWatchlist((prev) => {
        const uniquePrev = Array.from(new Set(prev));
        const isAdding = !uniquePrev.includes(symbol);
        const next = isAdding
          ? [...uniquePrev, symbol]
          : uniquePrev.filter((s) => s !== symbol);
        const cleanNext = Array.from(new Set(next));
        try {
          localStorage.setItem('crypto_screener_watchlist_guest', JSON.stringify(cleanNext));
        } catch (e) {}
        return cleanNext;
      });
      return;
    }
    setWatchlist((prev) => {
      const uniquePrev = Array.from(new Set(prev));
      const isAdding = !uniquePrev.includes(symbol);
      const next = isAdding
        ? [...uniquePrev, symbol]
        : uniquePrev.filter((s) => s !== symbol);
      const cleanNext = Array.from(new Set(next));
      try {
        localStorage.setItem(`crypto_screener_watchlist_${user.uid}`, JSON.stringify(cleanNext));
      } catch (e) {}

      setWatchlistFolders((prevFolders) => {
        const entries = Object.entries(prevFolders);
        if (entries.length === 0) return prevFolders;

        const nextFolders: Record<string, string[]> = {};
        if (isAdding) {
          const alreadyAssigned = entries.some(([_, syms]) => Array.isArray(syms) && syms.includes(symbol));
          entries.forEach(([name, syms], idx) => {
            const list = Array.isArray(syms) ? [...syms] : [];
            if (!alreadyAssigned && idx === 0) {
              if (!list.includes(symbol)) list.push(symbol);
            }
            nextFolders[name] = list;
          });
        } else {
          entries.forEach(([name, syms]) => {
            nextFolders[name] = Array.isArray(syms) ? syms.filter((s) => s !== symbol) : [];
          });
        }

        try {
          localStorage.setItem(`crypto_screener_watchlist_folders_${user.uid}`, JSON.stringify(nextFolders));
        } catch {}
        updateProfileData({ watchlistFolders: nextFolders }).catch(() => {});

        return nextFolders;
      });

      updateProfileData({ watchlist: cleanNext }).catch(() => {});
      return cleanNext;
    });
  };

  // The drawer has an explicit delete action, including for favorites that are
  // no longer part of the scan. Never toggle a missing entry back on.
  const handleRemoveWatchlistEntries = (sourceKeys: string[]) => {
    if (!user || sourceKeys.length === 0) return;
    const removed = new Set(sourceKeys);
    setWatchlist((prev) => {
      const next = prev.filter((key) => !removed.has(key));
      if (next.length === prev.length) return prev;
      try {
        localStorage.setItem(`crypto_screener_watchlist_${user.uid}`, JSON.stringify(next));
      } catch {}
      updateProfileData({ watchlist: next }).catch(() => {});
      return next;
    });
  };

  const handleWatchlistFoldersChange = (folders: Record<string, string[]>) => {
    if (!user) return;
    setWatchlistFolders(folders);
    try {
      localStorage.setItem(`crypto_screener_watchlist_folders_${user.uid}`, JSON.stringify(folders));
    } catch {}
    updateProfileData({ watchlistFolders: folders }).catch(() => {});
  };

  // Toggle sound
  const handleToggleSound = () => {
    setSoundEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('crypto_screener_sound', String(next));
      } catch (e) {}
      return next;
    });
  };

  // Strict user-bound opt-in projection. Disabled mode returns the exact original arrays.
  const constructorSettings = useMemo(() =>
    profile?.uid === user?.uid && profile?.tpSlConstructorSettings
      ? normalizeTpSlSettings(profile.tpSlConstructorSettings) : undefined,
    [profile?.uid, profile?.tpSlConstructorSettings, user?.uid]);
  const projectedCoins = useMemo(() => projectUserCoins(coins, constructorSettings), [coins, constructorSettings]);
  const projectedEarlyCoins = useMemo(() => projectUserCoins(fullEarlyScan?.data ?? [], constructorSettings), [fullEarlyScan?.data, constructorSettings]);
  const activeEarlyCandidate = useMemo(() => selectedEarly
    ? resolveEarlyTpSl(selectedEarly.candidate, constructorSettings, selectedEarly.coin.symbol) : null,
    [selectedEarly?.candidate, selectedEarly?.coin.symbol, constructorSettings]);
  // Details follow the current user profile, including immediate AUTO restoration.
  // Archived historical snapshots are intentionally immutable.
  const activeSelectedPair = useMemo(() => {
    if (!selectedPair?.formation || selectedArchivedItem) return selectedPair;
    const currentCoin = projectedCoins.find(row =>
      row.symbol === selectedPair.coin.symbol && row.exchange === selectedPair.coin.exchange
      && row.marketType === selectedPair.coin.marketType && row.timeframe === selectedPair.coin.timeframe);
    const formation = currentCoin?.formations.find(row => row.id === selectedPair.formation?.id)
      ?? resolveFormationTpSl(selectedPair.formation, constructorSettings, selectedPair.coin.symbol);
    return { coin: currentCoin ?? selectedPair.coin, formation };
  }, [selectedPair, selectedArchivedItem, projectedCoins, constructorSettings]);

  // Filter distinct patterns first, then group by instrument for both cards and table.
  const flattenedItems = useMemo(
    () => getVisibleFormations(projectedCoins, filters, regularIndicatorFilters),
    [projectedCoins, filters, regularIndicatorFilters],
  );
  const hasTechnicalFilters = countActiveRegularIndicatorFilters(regularIndicatorFilters) > 0;
  const groupedItems = useMemo(() => groupVisibleFormations(flattenedItems), [flattenedItems]);
  const earlyItems = useMemo(
    () => getVisibleEarlyFormations(projectedEarlyCoins, earlyFilters, earlyStage),
    [projectedEarlyCoins, earlyFilters, earlyStage],
  );

  // Coins matching search query even if no formation is detected on current timeframe
  const matchingCoinsSearch = useMemo(() => {
    if (!filters.searchQuery.trim()) return [];
    const q = filters.searchQuery.toLowerCase().trim();
    return coins.filter(
      (c) => c.symbol.toLowerCase().includes(q) || c.baseAsset.toLowerCase().includes(q)
    );
  }, [coins, filters.searchQuery]);

  // Counts for header stats
  const bullishCount = useMemo(
    () => flattenedItems.filter((i) => i.formation.bias === 'bullish').length,
    [flattenedItems]
  );
  const bearishCount = useMemo(
    () => flattenedItems.filter((i) => i.formation.bias === 'bearish').length,
    [flattenedItems]
  );

  // Loading screen during initial authentication check
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#070a12] flex flex-col items-center justify-center p-4 text-slate-300">
        <img
          src="/h00k-loading-robot.svg"
          alt="h00k — анімований робот"
          width={100}
          height={70}
          className="mb-5 h-auto w-48 sm:w-56"
        />
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <div className="w-4 h-4 border-2 border-cyan-500/40 border-t-cyan-400 rounded-full animate-spin" />
          <span>Завантаження…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#070a12] text-slate-100 flex flex-col selection:bg-cyan-500/20 selection:text-cyan-300">
      {/* First-visit installation tip remains available to guests on all devices. */}
      <InstallAppButton variant="tip" />
      {/* Header */}
      <Header
        isLoading={isLoading}
        totalCoins={coins.length}
        formationsCount={flattenedItems.length}
        bullishCount={bullishCount}
        bearishCount={bearishCount}
        watchlistCount={watchlistCount}
        soundEnabled={soundEnabled}
        onToggleSound={handleToggleSound}
        onRefresh={() => earlyMode && activePage === 'screener' ? refreshFullEarlyScan() : fetchScreenerData()}
        onOpenWatchlist={() => {
          if (!user) {
            handleOpenAuthModal('signin', 'general');
            return;
          }
          setIsWatchlistOpen(true);
        }}
        onOpenArchive={() => {
          if (!user) {
            handleOpenAuthModal('signin', 'general');
            return;
          }
          setIsArchiveModalOpen(true);
        }}
        archiveCount={archivedFormations.length}
        onOpenGuide={() => setIsGuideOpen(true)}
        onOpenMetaScalp={() => {
          if (!user) {
            handleOpenAuthModal('signin', 'linking');
            return;
          }
          setIsLinkingModalOpen(true);
        }}
        metaScalpSettings={metaScalpSettings}
        onOpenTelegramAlerts={() => handleOpenTelegramAlerts()}
        telegramAlertsCount={activeAlertsCount}
        surveillanceCount={surveillanceActiveCount}
        lastUpdated={lastUpdated}
        onOpenAuth={() => handleOpenAuthModal('signin', null)}
        onOpenProfile={() => setIsProfileModalOpen(true)}
        activePage={activePage}
        onPageChange={handlePageChange}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-[2560px] 3xl:max-w-[3440px] w-full mx-auto px-2 sm:px-4 lg:px-6 2xl:px-8 py-2 sm:py-4 space-y-3 sm:space-y-4">
        {activePage === 'terminal' ? (
          <TerminalPage
            key={user?.uid || 'guest'}
            coins={coins}
            watchlist={watchlist}
            onToggleWatchlist={handleToggleWatchlist}
            onSendMetaScalp={handleSendToMetaScalp}
            metaScalpBinding={metaScalpSettings.binding}
            onOpenTelegramAlerts={handleOpenTelegramAlerts}
            onOpenFullscreenModal={(coin, formation) => handleSelectPair(coin, formation)}
            onReturnToPatterns={() => handlePageChange('screener')}
          />
        ) : activePage === 'replay' ? (
          <ReplayPage
            coins={coins}
            onNavigateToScreener={() => handlePageChange('screener')}
          />
        ) : activePage === 'surveillance' ? (
          <SurveillancePage
            availableCoins={coins}
            onSelectCoinForChart={(symbol, exchange, marketType) => {
              const matchedCoin = coins.find((c) => c.symbol === symbol);
              if (matchedCoin) {
                handleSelectPair(matchedCoin);
              }
            }}
            onOpenTelegramSettings={() => setIsTelegramModalOpen(true)}
            onNavigateToScreener={() => handlePageChange('screener')}
          />
        ) : activePage === 'screener' ? (
          <CoinScreenerPage
            onSelectCoin={handleSelectPair}
            onSendMetaScalp={handleSendToMetaScalp}
            metaScalpBinding={metaScalpSettings.binding}
            watchlist={watchlist}
            onToggleWatchlist={handleToggleWatchlist}
            onOpenTelegramAlerts={handleOpenTelegramAlerts}
            onOpenWatchlist={() => {
              if (!user) {
                handleOpenAuthModal('signin', 'general');
                return;
              }
              setIsWatchlistOpen(true);
            }}
            formationsCoins={coins}
            onOpenAuthModal={handleOpenAuthModal}
          />
        ) : (
          <>
            {/* Filters Toolbar */}
            <ScreenerFilters
              filters={earlyMode ? earlyFilters : filters}
              onFilterChange={(changes) => earlyMode
                ? setEarlyFilters((prev) => ({ ...prev, ...changes }))
                : setFilters((prev) => ({ ...prev, ...changes }))}
              earlyMode={earlyMode}
              earlyStage={earlyStage}
              onEarlyStageChange={setEarlyStage}
              regularIndicatorFilters={regularIndicatorFilters}
              onRegularIndicatorFilterChange={(changes) =>
                setRegularIndicatorFilters(prev => ({ ...prev, ...changes }))}
              onResetRegularIndicatorFilters={() =>
                setRegularIndicatorFilters({ ...DEFAULT_REGULAR_INDICATOR_FILTERS })}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
            />

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-slate-900/80 p-3">
              <div className="min-w-0">
                <div className="text-xs font-bold text-slate-100">Раннє виявлення формацій · W / M</div>
                <p className="text-[11px] text-slate-400">Повний пошук серед доступних USDT-пар обраної біржі, ринку й таймфрейму; структури до другого екстремуму та пробою шиї.</p>
              </div>
              <button type="button" role="switch" aria-checked={earlyMode}
                onClick={() => changeEarlyMode(!earlyMode)}
                className={'shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ' +
                  (earlyMode ? 'border-amber-500/50 bg-amber-500/20 text-amber-200' : 'border-slate-700 bg-slate-800 text-slate-300')}>
                {earlyMode ? 'Ранній режим увімкнено' : 'Увімкнути ранній режим'}
              </button>
            </div>

            <div className="px-1 text-[11px] text-slate-400" aria-live="polite">
              {earlyMode ? (earlyItems.length + ' попередніх W/M-сценаріїв') :
                (groupedItems.length + ' монет · ' + flattenedItems.length + ' формацій')}
              {!earlyMode && filters.densityConfirmedOnly && ' · щільність стакана підтверджена'}
            </div>

            {/* Error Notification */}
            {error && (
              <div className="flex items-center justify-between p-4 rounded-2xl bg-rose-950/40 border border-rose-800/80 text-rose-300 text-xs">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400" />
                  <span>{error}</span>
                </div>
                <button
                  onClick={() => fetchScreenerData()}
                  className="px-3 py-1 rounded-lg bg-rose-900/60 hover:bg-rose-900 font-semibold transition-colors"
                >
                  Повторити
                </button>
              </div>
            )}

            {/* Results Area */}
            {earlyMode ? (
              <EarlyFormationsResults
                coins={projectedEarlyCoins}
                filters={earlyFilters}
                stage={earlyStage}
                loading={fullEarlyScan?.status === 'running' || fullEarlyScan?.status === 'loading' || !fullEarlyScan}
                scanProgress={fullEarlyScan}
                onRetryScan={refreshFullEarlyScan}
                onStopScan={stopFullEarlyScan}
                watchlist={watchlist}
                onToggleWatchlist={handleToggleWatchlist}
                onOpen={handleOpenEarly}
                onSendMetaScalp={handleSendToMetaScalp}
                metaScalpBinding={metaScalpSettings.binding}
                onOpenPriceAlert={(coin) => handleOpenTelegramAlerts({
                  symbol: coin.symbol,
                  exchange: coin.exchange,
                  marketType: coin.marketType,
                  currentPrice: coin.currentPrice,
                })}
              />
            ) : (
              <>
            {isLoading && coins.length === 0 ? (
              <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 min-[2200px]:grid-cols-7 min-[2800px]:grid-cols-8 gap-3 sm:gap-4">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((idx) => (
                  <div
                    key={idx}
                    className="h-56 rounded-2xl bg-slate-900/40 border border-slate-800/60 animate-pulse p-4 space-y-4"
                  >
                    <div className="flex justify-between items-center">
                      <div className="h-5 w-24 bg-slate-800 rounded-md" />
                      <div className="h-5 w-16 bg-slate-800 rounded-md" />
                    </div>
                    <div className="h-16 bg-slate-800/60 rounded-xl" />
                    <div className="h-10 bg-slate-800/40 rounded-xl" />
                  </div>
                ))}
              </div>
            ) : flattenedItems.length === 0 ? (
              !hasTechnicalFilters && matchingCoinsSearch.length > 0 ? (
                <div className="space-y-4">
                  <div className="p-4 rounded-2xl bg-cyan-950/30 border border-cyan-800/50 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <Sparkles className="w-5 h-5 text-cyan-400 shrink-0" />
                      <div>
                        <h4 className="text-sm font-bold text-white">
                          Знайдено {matchingCoinsSearch.length} монет за пошуком "{filters.searchQuery.toUpperCase()}"
                        </h4>
                        <p className="text-xs text-slate-400">
                          На поточному таймфреймі ({filters.timeframe}) активних геометричних патернів ще не сформовано. Ви можете відкрити монету в терміналі або змінити таймфрейм:
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setActivePage('screener')}
                      className="px-3.5 py-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-xs font-semibold text-white transition-colors"
                    >
                      <span className="inline-flex items-center gap-1.5"><ScreenerIcon className="w-3.5 h-3.5 shrink-0" />Відкрити у Скрінері Монет →</span>
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {matchingCoinsSearch.map((coin) => (
                      <div
                        key={`${coin.exchange}-${coin.symbol}-${coin.marketType}`}
                        onClick={() => {
                          handleSelectPair(coin);
                        }}
                        className="bg-slate-900/60 border border-slate-800 hover:border-cyan-500/50 rounded-2xl p-4 cursor-pointer transition-all hover:shadow-lg hover:shadow-cyan-950/20 group"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-bold text-sm text-white group-hover:text-cyan-400 transition-colors">
                            {coin.symbol}
                          </span>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 uppercase font-mono">
                            {coin.exchange} • {coin.marketType}
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between mb-3">
                          <span className="text-lg font-mono font-bold text-white">
                            ${coin.currentPrice >= 1 ? coin.currentPrice.toLocaleString('en-US') : coin.currentPrice}
                          </span>
                          <span className={`text-xs font-mono font-semibold ${coin.priceChange24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {coin.priceChange24h >= 0 ? '+' : ''}{coin.priceChange24h.toFixed(2)}%
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-800/80 pt-2.5">
                          <span>Об'єм: ${(coin.volume24hUsd / 1_000_000).toFixed(1)}M</span>
                          <span className="inline-flex items-center gap-1 text-cyan-400 font-semibold group-hover:underline"><TerminalIcon className="w-3.5 h-3.5 shrink-0" />Термінал →</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="py-20 text-center rounded-3xl border border-slate-800/80 bg-slate-900/40 space-y-4">
                  <div className="w-12 h-12 rounded-2xl bg-slate-800 flex items-center justify-center mx-auto text-slate-400">
                    <FormationsIcon className="w-6 h-6" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-base font-bold text-white">Формацій не знайдено</h3>
                    <p className="text-xs text-slate-400 max-w-md mx-auto">
                      {hasTechnicalFilters
                        ? 'За активними технічними фільтрами ATR, RVOL, RSI, OI або дельти формацій немає. Скидання фільтрів відновить результати. OI доступний лише для ф’ючерсів, дельта/CVD — лише для Binance; відсутні дані не підміняються оцінками.'
                        : 'За поточними фільтрами активних формацій не виявлено. Спробуйте змінити таймфрейм (5m / 15m / 1h / 4h), обрати обидві біржі або скинути фільтри.'}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setFilters(DEFAULT_FILTERS);
                      setRegularIndicatorFilters({ ...DEFAULT_REGULAR_INDICATOR_FILTERS });
                    }}
                    className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition-colors"
                  >
                    {t('resetFilters')}
                  </button>
                </div>
              )
            ) : viewMode === 'grid' ? (
              <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 min-[2200px]:grid-cols-7 min-[2800px]:grid-cols-8 gap-3 sm:gap-4">
                {groupedItems.map(({ coin, formations, key }) => (
                  <FormationCard
                    key={key}
                    coin={coin}
                    formation={formations[0]}
                    formations={formations}
                    isWatchlisted={watchlist.includes(coin.symbol)}
                    onToggleWatchlist={handleToggleWatchlist}
                    onSelect={handleSelectPair}
                    onSendMetaScalp={handleSendToMetaScalp}
                    metaScalpBinding={metaScalpSettings.binding}
                    onOpenAlert={(c, f) =>
                      handleOpenTelegramAlerts({
                        symbol: c.symbol,
                        exchange: c.exchange,
                        marketType: c.marketType,
                        currentPrice: c.currentPrice,
                        targetPrice: f.levels.targetPrice,
                        formationName: f.name,
                        condition: f.levels.targetPrice >= c.currentPrice ? 'gte' : 'lte',
                      })
                    }
                  />
                ))}
              </div>
            ) : (
              <ScreenerTable
                items={groupedItems}
                watchlist={watchlist}
                onToggleWatchlist={handleToggleWatchlist}
                onSelect={handleSelectPair}
                onSendMetaScalp={handleSendToMetaScalp}
                metaScalpBinding={metaScalpSettings.binding}
                onOpenAlert={(c, f) =>
                  handleOpenTelegramAlerts({
                    symbol: c.symbol,
                    exchange: c.exchange,
                    marketType: c.marketType,
                    currentPrice: c.currentPrice,
                    targetPrice: f.levels.targetPrice,
                    formationName: f.name,
                    condition: f.levels.targetPrice >= c.currentPrice ? 'gte' : 'lte',
                  })
                }
              />
            )}
              </>
            )}
          </>
        )}
      </main>

      <SiteFooter />

      {/* Early W/M scenarios open the fullscreen HookChart directly. */}
      {selectedEarly && activeEarlyCandidate && (
        <FullscreenChartModal
          key={[user?.uid ?? 'guest', selectedEarly.coin.exchange, selectedEarly.coin.marketType, selectedEarly.coin.symbol, selectedEarly.coin.timeframe, selectedEarly.candidate.id].join(':')}
          isOpen
          coin={selectedEarly.coin}
          formation={null}
          earlyCandidate={activeEarlyCandidate}
          earlyTouchRule={activeEarlyCandidate.tpSlBuilder?.touches.verified
            ? getTpSlRule(constructorSettings, selectedEarly.coin.symbol, activeEarlyCandidate.patternKey)
            : undefined}
          customMarkers={earlyFormationChartMarkers(activeEarlyCandidate)}
          currentTimeframe={selectedEarly.coin.timeframe}
          livePrice={selectedEarly.coin.currentPrice}
          allCoins={coins}
          watchlist={watchlist}
          onToggleWatchlist={handleToggleWatchlist}
          onOpenTelegramModal={handleOpenTelegramAlerts}
          onSendMetaScalp={handleSendToMetaScalp}
          metaScalpBinding={metaScalpSettings.binding}
          onClose={() => setSelectedEarly(null)}
        />
      )}
      {/* Detailed chart: extended formation analysis when available, full chart otherwise */}
      {activeSelectedPair?.formation ? (
        <FormationDetailsModal
          coin={activeSelectedPair.coin}
          formation={activeSelectedPair.formation}
          onFormationChange={(nextFormation) => {
            setSelectedArchivedItem(null);
            setSelectedPair((previous) => {
              if (!previous) return previous;
              const rawCoin = coins.find(row =>
                row.symbol === previous.coin.symbol && row.exchange === previous.coin.exchange
                && row.marketType === previous.coin.marketType && row.timeframe === previous.coin.timeframe);
              const raw = rawCoin?.formations.find(row => row.id === nextFormation.id);
              return { coin: rawCoin ?? previous.coin, formation: raw ?? nextFormation };
            });
          }}
          archivedItem={selectedArchivedItem}
          allCoins={coins}
          watchlist={watchlist}
          onToggleWatchlist={handleToggleWatchlist}
          onClose={() => {
            setSelectedPair(null);
            setSelectedArchivedItem(null);
          }}
          onSendMetaScalp={handleSendToMetaScalp}
          metaScalpBinding={metaScalpSettings.binding}
          onOpenTelegramModal={handleOpenTelegramAlerts}
          onOpenAuth={() => setIsAuthModalOpen(true)}
          onAlertToast={handleAlertToast}
        />
      ) : selectedPair ? (
        <FullscreenChartModal
          isOpen={true}
          coin={selectedPair.coin}
          formation={null}
          currentTimeframe={selectedPair.coin.timeframe || preferences.defaultTimeframe}
          livePrice={selectedPair.coin.currentPrice}
          allCoins={coins}
          watchlist={watchlist}
          onToggleWatchlist={handleToggleWatchlist}
          onClose={() => {
            setSelectedPair(null);
            setSelectedArchivedItem(null);
          }}
          onSendMetaScalp={handleSendToMetaScalp}
          metaScalpBinding={metaScalpSettings.binding}
          onOpenTelegramModal={handleOpenTelegramAlerts}
        />
      ) : null}

      {/* Formations Archive Modal */}
      <ArchiveModal
        isOpen={isArchiveModalOpen}
        onClose={() => setIsArchiveModalOpen(false)}
        onSelectFormation={handleSelectArchivedFormation}
        onOpenAuth={() => setIsAuthModalOpen(true)}
      />

      {/* Encyclopedia / Guide Modal */}
      <FormationGuideModal
        isOpen={isGuideOpen}
        onClose={() => setIsGuideOpen(false)}
      />

      {/* Watchlist Drawer */}
      <WatchlistDrawer
        isOpen={isWatchlistOpen}
        onClose={() => setIsWatchlistOpen(false)}
        watchlistSymbols={watchlist}
        allCoins={coins}
        onRemove={handleRemoveWatchlistEntries}
        folders={watchlistFolders}
        onFoldersChange={handleWatchlistFoldersChange}
        onSendMetaScalp={handleSendToMetaScalp}
        metaScalpBinding={metaScalpSettings.binding}
      />

      {/* MetaScalp Terminal Linking Modal */}
      <MetaScalpModal
        key={user?.uid || 'guest'}
        isOpen={isLinkingModalOpen}
        onClose={() => setIsLinkingModalOpen(false)}
        settings={metaScalpSettings}
        onSettingsChange={handleMetaScalpSettingsChange}
        currentSymbol={selectedPair?.coin.symbol || coins[0]?.symbol || 'BTCUSDT'}
        currentExchange={selectedPair?.coin.exchange || coins[0]?.exchange || 'binance'}
        currentMarketType={selectedPair?.coin.marketType || coins[0]?.marketType || 'futures'}
      />

      {/* MetaScalp Notification Toast */}
      <MetaScalpToast
        toast={metaScalpToast}
        onDismiss={() => setMetaScalpToast(null)}
      />

      {/* Telegram Alerts & Configuration Modal */}
      <TelegramAlertsModal
        key={`telegram-${user?.uid || 'guest'}`}
        isOpen={isTelegramModalOpen}
        onClose={() => setIsTelegramModalOpen(false)}
        prefill={telegramPrefill}
        onOpenAuth={() => handleOpenAuthModal('signin', 'alerts')}
        onAlertCreated={(alert) => {
          setAlertToast({
            id: Date.now(),
            symbol: alert.symbol,
            targetPrice: alert.targetPrice,
            condition: alert.condition,
            message: alert.note || alert.formationName || 'Алерт додано в чергу моніторингу',
          });
        }}
      />

      {/* User Authentication Modal (Registration / Login) */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => {
          setIsAuthModalOpen(false);
          setAuthPromptReason(null);
        }}
        initialMode={authInitialMode}
        promptReason={authPromptReason}
        onSuccess={() => {
          setIsAuthModalOpen(false);
          setAuthPromptReason(null);
        }}
      />

      {/* User Profile & Isolated Settings Modal */}
      <UserProfileModal
        key={`profile-${user?.uid || 'guest'}`}
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        onOpenAlerts={() => handleOpenTelegramAlerts()}
        onOpenArchive={() => setIsArchiveModalOpen(true)}
      />

      {/* Telegram Alert Notification Toast */}
      <AlertToast
        toast={alertToast}
        onDismiss={() => setAlertToast(null)}
      />
    </div>
  );
}

