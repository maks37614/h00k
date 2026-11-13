import { normalizeExchangeSymbol } from '../utils/marketSymbols';
import { CopyableCoinSymbol } from './CopyableCoinSymbol';
import { useTelegram } from '../context/TelegramContext';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Sparkles,
  Target,
  ShieldAlert,
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
  Zap,
  Send,
  Bell,
  Plus,
  Trash2,
  Pause,
  Play,
  ArrowUpRight,
  ArrowDownRight,
  AlertCircle,
  CheckCircle2,
  Lock,
  LogIn,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { ScannedCoin, DetectedFormation, Kline, FormationAIAnalysis, Timeframe, ArchivedFormation } from '../types';
import { TradingViewChart } from './TradingViewChart';
import type { ChartPageOrigin } from '../utils/chartPageRoute';
import { FullscreenChartModal } from './FullscreenChartModal';
import { formatCryptoPrice } from '../utils/formatters';
import { fetchDirectKlines } from '../utils/directExchangeClient';
import { useAuth } from '../context/AuthContext';
import { useAlerts } from '../context/AlertsContext';
import { useArchive } from '../context/ArchiveContext';
import { SmartAnalysisBlock } from './SmartAnalysisBlock';
import { SiteFooter } from './SiteFooter';
import { chartCrosshairAlertPrice } from '../utils/chartAlertPrice';
import {
  readSmartAnalysisPanelCollapsed, saveSmartAnalysisPanelCollapsed,
  smartAnalysisPanelStorageKey, isSmartAnalysisPanelSyncPending,
  saveSmartAnalysisPanelSyncPending,
} from '../utils/smartAnalysisPanelPreference';
import { ChartTopAnalysisText } from './ChartTopAnalysisText';
import {
  readTelegramAlertPanelCollapsed,
  saveTelegramAlertPanelCollapsed,
  telegramAlertPanelStorageKey,
  isTelegramAlertPanelSyncPending,
  saveTelegramAlertPanelSyncPending,
} from '../utils/telegramAlertPanelPreference';

interface FormationDetailsModalProps {
  coin: ScannedCoin | null;
  formation: DetectedFormation | null;
  onFormationChange?: (formation: DetectedFormation) => void;
  onClose: () => void;
  /** Standalone page instead of the historical overlay. */
  pageMode?: boolean;
  /** Real navigation source, independent of whether the selected coin has a formation. */
  visualOrigin?: ChartPageOrigin;
  /** Keep the standalone chart URL on the user's selected timeframe. */
  initialTimeframe?: Timeframe;
  onPageTimeframeChange?: (timeframe: Timeframe) => void;
  onSendMetaScalp?: (coin: ScannedCoin) => void;
  metaScalpBinding?: string;
  onOpenTelegramModal?: (prefill?: any) => void;
  onOpenAuth?: () => void;
  onAlertToast?: (toast: { symbol: string; targetPrice: number; condition: 'gte' | 'lte'; message?: string }) => void;
  archivedItem?: ArchivedFormation | null;
  allCoins?: ScannedCoin[];
  watchlist?: string[];
  onToggleWatchlist?: (symbol: string) => void;
}

export const FormationDetailsModal: React.FC<FormationDetailsModalProps> = ({
  coin,
  formation,
  onFormationChange,
  onClose,
  pageMode = false,
  visualOrigin = 'formations',
  initialTimeframe,
  onPageTimeframeChange,
  onSendMetaScalp,
  metaScalpBinding = '001',
  onOpenTelegramModal,
  onOpenAuth,
  onAlertToast,
  archivedItem,
  allCoins = [],
  watchlist = [],
  onToggleWatchlist,
}) => {
  const { status: telegramStatus } = useTelegram();
  if (!coin || !formation) return null;

  // Keep all detected patterns available in the detailed view, including an
  // archived pattern that is no longer present in the latest scanner snapshot.
  const formationOptions = Array.from(new Map<string, DetectedFormation>(
    [formation, ...coin.formations].map((item): [string, DetectedFormation] => [item.id, item])
  ).values());

  const { user, profile, updateProfileData } = useAuth();
  const { alerts, addAlert, addAlertsBatch, deleteAlert, toggleAlert } = useAlerts();
  const { isArchived, saveToArchive } = useArchive();

  const alreadyArchived = isArchived(coin.symbol, formation.id || formation.name);
  const [isSavingArchive, setIsSavingArchive] = useState<boolean>(false);
  const [archiveToastMsg, setArchiveToastMsg] = useState<string | null>(null);

  const chartSectionRef = useRef<HTMLDivElement>(null);

  // The standalone chart uses normal document scrolling and browser history.
  // Preserve the original scroll lock only for legacy modal callers.
  useEffect(() => {
    if (pageMode) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = setTimeout(() => {
      chartSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
    return () => {
      document.body.style.overflow = originalOverflow;
      clearTimeout(focusTimer);
    };
  }, [pageMode]);

  const [timeframe, setTimeframe] = useState<Timeframe>(
    initialTimeframe || archivedItem?.chartParams?.timeframe || archivedItem?.timeframe || coin.timeframe || '1h'
  );
  const [historyLimit, setHistoryLimit] = useState<number>(
    archivedItem?.chartParams?.historyLimit || 1000
  );
  const [livePrice, setLivePrice] = useState<number>(
    archivedItem?.savedPrice || coin.currentPrice
  );
  const [liveStatus, setLiveStatus] = useState<{ isConnected: boolean; mode: 'ws' | 'rest' }>({
    isConnected: true,
    mode: 'ws',
  });
  const [klines, setKlines] = useState<Kline[]>([]);
  const [loadingKlines, setLoadingKlines] = useState<boolean>(true);
  const [aiAnalysis, setAiAnalysis] = useState<FormationAIAnalysis | null>(null);
  const [loadingAi, setLoadingAi] = useState<boolean>(false);
  const aiRequestRef = useRef(0);
  useEffect(() => {
    // AI commentary belongs to the selected pattern, not just to its coin.
    aiRequestRef.current += 1;
    setAiAnalysis(null);
    setLoadingAi(false);
  }, [formation.id]);
  const [alertFeedback, setAlertFeedback] = useState<string | null>(null);
  const [settingAlert, setSettingAlert] = useState<string | null>(null);

  const handleSaveToArchive = async () => {
    if (isSavingArchive) return;
    setIsSavingArchive(true);
    try {
      if (alreadyArchived) {
        setArchiveToastMsg('Формація вже в архіві');
        setTimeout(() => setArchiveToastMsg(null), 3000);
        return;
      }
      await saveToArchive(coin, formation, {
        timeframe,
        historyLimit,
        currentPrice: livePrice || coin.currentPrice,
      });
      setArchiveToastMsg('Формацію додано в архів!');
      onAlertToast?.({
        symbol: coin.symbol,
        targetPrice: formation.levels.targetPrice,
        condition: 'gte',
        message: `${formation.name} • Збережено в архів формацій`,
      });
      setTimeout(() => setArchiveToastMsg(null), 3500);
    } catch (err: any) {
      console.error('Failed to save to archive:', err);
      setArchiveToastMsg('Помилка збереження');
      setTimeout(() => setArchiveToastMsg(null), 3000);
    } finally {
      setIsSavingArchive(false);
    }
  };

  // One visibility preference for all coins and formation detail pages.
  // The user profile also syncs it across devices; local storage is an
  // immediate per-account fallback across page reloads and browser tabs.
  const alertPanelStorage = () => {
    try { return window.localStorage; } catch { return null; }
  };
  const alertPanelKey = telegramAlertPanelStorageKey(user?.uid);
  const [telegramAlertPanelCollapsed, setTelegramAlertPanelCollapsed] = useState<boolean>(
    () => readTelegramAlertPanelCollapsed(alertPanelStorage(), user?.uid)
  );
  const [telegramAlertPanelSaveError, setTelegramAlertPanelSaveError] = useState(false);
  const pendingTelegramAlertPreferenceWrites = useRef(0);

  useEffect(() => {
    if (pendingTelegramAlertPreferenceWrites.current > 0) return;
    const profilePreference = profile?.uid === user?.uid
      ? profile?.telegramPriceAlertCollapsed : undefined;
    const syncPending = !!user?.uid && isTelegramAlertPanelSyncPending(alertPanelStorage(), user.uid);
    const collapsed = !syncPending && typeof profilePreference === 'boolean'
      ? profilePreference : readTelegramAlertPanelCollapsed(alertPanelStorage(), user?.uid);
    setTelegramAlertPanelCollapsed(collapsed);
    saveTelegramAlertPanelCollapsed(alertPanelStorage(), collapsed, user?.uid);
  }, [user?.uid, profile?.uid, profile?.telegramPriceAlertCollapsed]);

  useEffect(() => {
    const onStorageChange = (event: StorageEvent) => {
      if (event.key === alertPanelKey) {
        setTelegramAlertPanelCollapsed(event.newValue === 'true');
      }
    };
    window.addEventListener('storage', onStorageChange);
    return () => window.removeEventListener('storage', onStorageChange);
  }, [alertPanelKey]);

  const toggleTelegramAlertPanel = () => {
    const collapsed = !telegramAlertPanelCollapsed;
    setTelegramAlertPanelCollapsed(collapsed);
    setTelegramAlertPanelSaveError(false);
    saveTelegramAlertPanelCollapsed(alertPanelStorage(), collapsed, user?.uid);
    if (!user) return;

    saveTelegramAlertPanelSyncPending(alertPanelStorage(), user.uid, true);
    pendingTelegramAlertPreferenceWrites.current += 1;
    void updateProfileData({ telegramPriceAlertCollapsed: collapsed })
      .then(() => {
        if (pendingTelegramAlertPreferenceWrites.current === 1) {
          saveTelegramAlertPanelSyncPending(alertPanelStorage(), user.uid, false);
        }
      })
      .catch(() => setTelegramAlertPanelSaveError(true))
      .finally(() => { pendingTelegramAlertPreferenceWrites.current -= 1; });
  };

  // AI + Quant visibility is independent from the Telegram panel and shared
  // across every coin. The signed-in profile is the cross-device authority.
  const smartAnalysisStorageKey = smartAnalysisPanelStorageKey(user?.uid);
  const [smartAnalysisCollapsed, setSmartAnalysisCollapsed] = useState(
    () => readSmartAnalysisPanelCollapsed(alertPanelStorage(), user?.uid)
  );
  const [smartAnalysisSaveError, setSmartAnalysisSaveError] = useState(false);
  const pendingSmartAnalysisWrites = useRef(0);

  useEffect(() => {
    if (pendingSmartAnalysisWrites.current > 0) return;
    const saved = profile?.uid === user?.uid ? profile.smartAnalysisCollapsed : undefined;
    const pending = !!user?.uid && isSmartAnalysisPanelSyncPending(alertPanelStorage(), user.uid);
    const collapsed = !pending && typeof saved === 'boolean'
      ? saved : readSmartAnalysisPanelCollapsed(alertPanelStorage(), user?.uid);
    setSmartAnalysisCollapsed(collapsed);
    saveSmartAnalysisPanelCollapsed(alertPanelStorage(), collapsed, user?.uid);
  }, [user?.uid, profile?.uid, profile?.smartAnalysisCollapsed]);

  useEffect(() => {
    const syncAcrossTabs = (event: StorageEvent) => {
      if (event.key === smartAnalysisStorageKey) {
        setSmartAnalysisCollapsed(event.newValue === 'true');
      }
    };
    window.addEventListener('storage', syncAcrossTabs);
    return () => window.removeEventListener('storage', syncAcrossTabs);
  }, [smartAnalysisStorageKey]);

  const toggleSmartAnalysis = () => {
    const next = !smartAnalysisCollapsed;
    setSmartAnalysisCollapsed(next);
    setSmartAnalysisSaveError(false);
    saveSmartAnalysisPanelCollapsed(alertPanelStorage(), next, user?.uid);
    if (!user) return;
    saveSmartAnalysisPanelSyncPending(alertPanelStorage(), user.uid, true);
    pendingSmartAnalysisWrites.current += 1;
    void updateProfileData({ smartAnalysisCollapsed: next })
      .then(() => {
        if (pendingSmartAnalysisWrites.current === 1) {
          saveSmartAnalysisPanelSyncPending(alertPanelStorage(), user.uid, false);
        }
      })
      .catch(() => setSmartAnalysisSaveError(true))
      .finally(() => { pendingSmartAnalysisWrites.current -= 1; });
  };

  // Custom price alert under chart state
  const [customAlertPrice, setCustomAlertPrice] = useState<string>('');
  const customAlertPriceInputRef = useRef<HTMLInputElement>(null);
  const crosshairPriceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCrosshairPrice = useRef<number | null>(null);
  const lastCrosshairPriceAppliedAt = useRef(0);
  const [customAlertCondition, setCustomAlertCondition] = useState<'gte' | 'lte'>('gte');
  const [customAlertNote, setCustomAlertNote] = useState<string>('');
  const [settingCustomAlert, setSettingCustomAlert] = useState<boolean>(false);
  const [customAlertSuccess, setCustomAlertSuccess] = useState<string | null>(null);
  const [customAlertError, setCustomAlertError] = useState<string | null>(null);

  // Cursor movements update only the draft price, never create/delete alerts.
  // Throttle updates while dragging and flush the last sampled price at rest.
  const applyCrosshairAlertPrice = useCallback((price: number) => {
    if (document.activeElement === customAlertPriceInputRef.current) return;
    const value = chartCrosshairAlertPrice(price);
    if (!value) return;
    setCustomAlertPrice(previous => previous === value ? previous : value);
    const direction = price >= (livePrice || coin.currentPrice) ? 'gte' : 'lte';
    setCustomAlertCondition(previous => previous === direction ? previous : direction);
  }, [livePrice, coin.currentPrice]);

  const handleCrosshairAlertPrice = useCallback((price: number) => {
    if (telegramAlertPanelCollapsed || !Number.isFinite(price) || price <= 0) return;
    if (document.activeElement === customAlertPriceInputRef.current) return;
    latestCrosshairPrice.current = price;
    const now = performance.now();
    const remaining = 85 - (now - lastCrosshairPriceAppliedAt.current);
    if (remaining <= 0) {
      lastCrosshairPriceAppliedAt.current = now;
      if (crosshairPriceTimer.current !== null) {
        clearTimeout(crosshairPriceTimer.current);
        crosshairPriceTimer.current = null;
      }
      applyCrosshairAlertPrice(price);
    } else if (crosshairPriceTimer.current === null) {
      crosshairPriceTimer.current = setTimeout(() => {
        crosshairPriceTimer.current = null;
        lastCrosshairPriceAppliedAt.current = performance.now();
        const latest = latestCrosshairPrice.current;
        if (latest !== null) applyCrosshairAlertPrice(latest);
      }, remaining);
    }
  }, [telegramAlertPanelCollapsed, applyCrosshairAlertPrice]);

  useEffect(() => () => {
    if (crosshairPriceTimer.current !== null) {
      clearTimeout(crosshairPriceTimer.current);
      crosshairPriceTimer.current = null;
    }
  }, [telegramAlertPanelCollapsed, coin.symbol]);

  // Fullscreen chart modal state
  const [isFullscreenChartOpen, setIsFullscreenChartOpen] = useState<boolean>(false);

  // Keyboard shortcut 'f' to toggle fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        setIsFullscreenChartOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const cleanSymbol = useMemo(() => coin.symbol.toUpperCase().replace('/', '').trim(), [coin.symbol]);
  const coinAlerts = useMemo(() => alerts.filter((a) => a.symbol === cleanSymbol), [alerts, cleanSymbol]);

  const isTelegramConfigured = Boolean(telegramStatus?.isConfigured);

  // Keep livePrice in sync if coin changes
  useEffect(() => {
    if (coin?.currentPrice) {
      setLivePrice(coin.currentPrice);
      if (!customAlertPrice) {
        setCustomAlertPrice(coin.currentPrice.toString());
      }
    }
  }, [coin?.currentPrice]);

  // Quick percent deltas
  const applyPercentDelta = (percent: number) => {
    const base = livePrice || coin.currentPrice;
    if (!base) return;
    const newPrice = base * (1 + percent / 100);
    let formatted: string;
    if (newPrice >= 1000) formatted = newPrice.toFixed(2);
    else if (newPrice >= 1) formatted = newPrice.toFixed(4);
    else if (newPrice >= 0.0001) formatted = newPrice.toFixed(6);
    else formatted = newPrice.toFixed(8);

    setCustomAlertPrice(formatted);
    if (percent >= 0) {
      setCustomAlertCondition('gte');
    } else {
      setCustomAlertCondition('lte');
    }
  };

  const handleCustomPriceChange = (val: string) => {
    setCustomAlertPrice(val);
    const num = parseFloat(val);
    if (!isNaN(num) && livePrice) {
      setCustomAlertCondition(num >= livePrice ? 'gte' : 'lte');
    }
  };

  // Submit custom price alert
  const handleCreateCustomAlert = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!user) {
      setCustomAlertError('Встановлювати сповіщення можуть тільки зареєстровані користувачі');
      onOpenAuth?.();
      return;
    }

    const priceNum = parseFloat(customAlertPrice);
    if (isNaN(priceNum) || priceNum <= 0) {
      setCustomAlertError('Введіть коректну ціну');
      return;
    }

    setSettingCustomAlert(true);
    setCustomAlertError(null);
    setCustomAlertSuccess(null);

    try {
      await addAlert({
        symbol: coin.symbol,
        exchange: coin.exchange,
        marketType: coin.marketType,
        targetPrice: priceNum,
        condition: customAlertCondition,
        formationName: formation.name,
        levelType: 'custom',
        note: customAlertNote.trim() || `Ціль $${formatCryptoPrice(priceNum)}`,
      });

      setCustomAlertSuccess(`Сповіщення на $${formatCryptoPrice(priceNum)} додано!`);
      setCustomAlertNote('');
      onAlertToast?.({
        symbol: coin.symbol,
        targetPrice: priceNum,
        condition: customAlertCondition,
        message: `${coin.symbol} • Своя ціль $${formatCryptoPrice(priceNum)} додана`,
      });
      setTimeout(() => setCustomAlertSuccess(null), 3500);
    } catch (err: any) {
      setCustomAlertError(err.message || 'Не вдалося створити сповіщення');
    } finally {
      setSettingCustomAlert(false);
    }
  };

  const handleToggleCoinAlert = async (id: string) => {
    try {
      await toggleAlert(id);
    } catch (err) {
      console.error('Failed to toggle alert:', err);
    }
  };

  const handleDeleteCoinAlert = async (id: string) => {
    try {
      await deleteAlert(id);
    } catch (err) {
      console.error('Failed to delete alert:', err);
    }
  };

  // Fetch klines when modal opens, timeframe changes, or historyLimit changes
  useEffect(() => {
    let isCancelled = false;

    async function loadKlines() {
      if (!coin) return;
      setLoadingKlines(true);
      const cleanSym = normalizeExchangeSymbol(coin.symbol || '');
      try {
        const res = await fetch(
          `/api/klines?exchange=${coin.exchange}&market=${coin.marketType}&symbol=${encodeURIComponent(cleanSym)}&timeframe=${timeframe}&limit=${historyLimit}`
        );
        const data = await res.json();
        if (!isCancelled && data.success && Array.isArray(data.data) && data.data.length > 0) {
          setKlines(data.data);
          setLivePrice(data.data[data.data.length - 1].close);
          return;
        }

        // Direct exchange fallback (e.g. if server is blocked or returns empty)
        const directData = await fetchDirectKlines(coin.exchange, coin.marketType, cleanSym, timeframe as Timeframe, historyLimit);
        if (!isCancelled && directData.length > 0) {
          setKlines(directData);
          setLivePrice(directData[directData.length - 1].close);
        }
      } catch (err) {
        console.error('Failed to load klines from server, trying direct exchange:', err);
        try {
          const directData = await fetchDirectKlines(coin.exchange, coin.marketType, cleanSym, timeframe as Timeframe, historyLimit);
          if (!isCancelled && directData.length > 0) {
            setKlines(directData);
            setLivePrice(directData[directData.length - 1].close);
          }
        } catch (directErr) {
          console.error('Direct klines fallback error:', directErr);
        }
      } finally {
        if (!isCancelled) setLoadingKlines(false);
      }
    }

    loadKlines();

    return () => {
      isCancelled = true;
    };
  }, [coin, timeframe, historyLimit]);

  // Trigger AI analysis
  const handleRequestAi = async () => {
    if (loadingAi) return;
    const requestId = ++aiRequestRef.current;
    setLoadingAi(true);
    try {
      const res = await fetch('/api/ai/analyze-formation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: coin.symbol,
          exchange: coin.exchange,
          timeframe,
          formation,
          currentPrice: coin.currentPrice,
          recentCandles: klines.slice(-10),
        }),
      });

      const data = await res.json();
      if (requestId === aiRequestRef.current && data.success && data.analysis) {
        setAiAnalysis(data.analysis);
      }
    } catch (err) {
      if (requestId === aiRequestRef.current) console.error('Failed to get AI analysis:', err);
    } finally {
      if (requestId === aiRequestRef.current) setLoadingAi(false);
    }
  };

  const isBullish = formation.bias === 'bullish';
  const isBearish = formation.bias === 'bearish';

  const formatPrice = (price: number) => formatCryptoPrice(price);

  // Set Telegram price alert
  const handleSetAlert = async (levelType: 'entry' | 'target' | 'stop_loss', targetPrice: number) => {
    if (!targetPrice) return;
    if (levelType === 'entry' && formation.tpSlBuilder?.touches?.ready === false) {
      setAlertFeedback('Вхід очікує потрібну кількість підтверджених дотиків High/Low');
      return;
    }

    if (!user) {
      setAlertFeedback('Тільки для зареєстрованих');
      onAlertToast?.({
        symbol: coin.symbol,
        targetPrice,
        condition: targetPrice >= livePrice ? 'gte' : 'lte',
        message: 'Встановлення сповіщень доступне тільки для зареєстрованих користувачів. Будь ласка, увійдіть.',
      });
      onOpenAuth?.();
      return;
    }

    setSettingAlert(levelType);
    setAlertFeedback(null);

    const isBull = formation.bias === 'bullish';
    let condition: 'gte' | 'lte';
    if (levelType === 'target') {
      condition = isBull ? 'gte' : 'lte';
    } else if (levelType === 'stop_loss') {
      condition = isBull ? 'lte' : 'gte';
    } else {
      condition = targetPrice >= livePrice ? 'gte' : 'lte';
    }

    const levelLabel = levelType === 'entry' ? 'Вхід' : levelType === 'target' ? 'Тейк-профіт' : 'Стоп-лосс';

    try {
      await addAlert({
        symbol: coin.symbol,
        exchange: coin.exchange,
        marketType: coin.marketType,
        targetPrice,
        condition,
        formationName: formation.name,
        levelType,
        note: `${formation.name} - ${levelLabel}`,
      });

      setAlertFeedback(`Алерт на ${levelLabel} додано!`);
      onAlertToast?.({
        symbol: coin.symbol,
        targetPrice,
        condition,
        message: `${formation.name} • ${levelLabel} ($${formatPrice(targetPrice)})`,
      });
      setTimeout(() => setAlertFeedback(null), 3000);
    } catch (err: any) {
      setAlertFeedback(err.message || 'Помилка');
    } finally {
      setSettingAlert(null);
    }
  };

  // Set Telegram alert from Realtime Liquidity widget
  const handleSetQuickLiquidityAlert = async (targetPrice: number, label: string, condition: 'gte' | 'lte') => {
    if (!targetPrice) return;
    if (!user) {
      onAlertToast?.({
        symbol: coin.symbol,
        targetPrice,
        condition,
        message: 'Встановлення сповіщень доступне для зареєстрованих користувачів. Будь ласка, увійдіть.',
      });
      onOpenAuth?.();
      return;
    }
    try {
      await addAlert({
        symbol: coin.symbol,
        exchange: coin.exchange,
        marketType: coin.marketType,
        targetPrice,
        condition,
        formationName: label,
        levelType: 'custom',
        note: `${coin.symbol} • ${label}`,
      });
      onAlertToast?.({
        symbol: coin.symbol,
        targetPrice,
        condition,
        message: `Сповіщення Telegram встановлено: ${label} ($${formatPrice(targetPrice)})`,
      });
    } catch (err: any) {
      console.error('Failed to set liquidity alert:', err);
    }
  };

  // Set all 3 alerts at once (Entry, Take Profit, Stop Loss)
  const handleSetAllAlerts = async () => {
    if (formation.tpSlBuilder?.touches?.ready === false) {
      setAlertFeedback('Спочатку дочекайтеся підтвердження дотиків High/Low для Entry');
      return;
    }
    if (!user) {
      setAlertFeedback('Тільки для зареєстрованих');
      onAlertToast?.({
        symbol: coin.symbol,
        targetPrice: formation.levels.targetPrice,
        condition: 'gte',
        message: 'Встановлення сповіщень доступне тільки для зареєстрованих користувачів. Будь ласка, увійдіть.',
      });
      onOpenAuth?.();
      return;
    }

    setSettingAlert('all');
    setAlertFeedback(null);
    try {
      const isBull = formation.bias === 'bullish';
      const entryCond = formation.levels.entryPrice >= livePrice ? 'gte' : 'lte';
      const targetCond = isBull ? 'gte' : 'lte';
      const stopLossCond = isBull ? 'lte' : 'gte';

      await addAlertsBatch([
        {
          symbol: coin.symbol,
          exchange: coin.exchange,
          marketType: coin.marketType,
          targetPrice: formation.levels.entryPrice,
          condition: entryCond,
          formationName: formation.name,
          levelType: 'entry',
          note: `${formation.name} - Вхід`,
        },
        {
          symbol: coin.symbol,
          exchange: coin.exchange,
          marketType: coin.marketType,
          targetPrice: formation.levels.targetPrice,
          condition: targetCond,
          formationName: formation.name,
          levelType: 'target',
          note: `${formation.name} - Тейк-профіт (+${formation.potentialProfitPct}%)`,
        },
        {
          symbol: coin.symbol,
          exchange: coin.exchange,
          marketType: coin.marketType,
          targetPrice: formation.levels.stopLossPrice,
          condition: stopLossCond,
          formationName: formation.name,
          levelType: 'stop_loss',
          note: `${formation.name} - Стоп-лосс (-${Math.abs(formation.potentialRiskPct)}%)`,
        },
      ]);

      setAlertFeedback('Всі 3 рівні додано в Telegram!');
      onAlertToast?.({
        symbol: coin.symbol,
        targetPrice: formation.levels.targetPrice,
        condition: targetCond,
        message: `${formation.name} • Всі 3 алерти додано в Telegram`,
      });
      setTimeout(() => setAlertFeedback(null), 3500);
    } catch (err: any) {
      setAlertFeedback(err.message || 'Помилка додавання');
    } finally {
      setSettingAlert(null);
    }
  };

  // Reuse the exact existing setup and all Telegram/AI actions in Smart Analysis.
  // Never create a second independent Entry/TP/SL plan for the same formation.
  const tradeSetupPanel = (
    <div id="formation-trade-setup-card" className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                      Виявлена формація
                    </span>
                    <h3 className="text-base font-extrabold text-white mt-0.5">{formation.name}</h3>
                  </div>
                  <span
                    className={`px-2.5 py-1 rounded-lg text-xs font-extrabold uppercase ${
                      isBullish
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : isBearish
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                        : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    }`}
                  >
                    {isBullish ? 'LONG ▲' : isBearish ? 'SHORT ▼' : 'NEUTRAL'}
                  </span>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/60 p-3 rounded-xl border border-slate-800/80">
                  {formation.description}
                </p>

                {/* Status & Confidence */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-slate-900/60 p-2.5 rounded-xl border border-slate-800/60">
                    <span className="text-slate-400 text-[10px] block">Статус патерну</span>
                    <span className="font-semibold text-slate-100">{formation.statusLabel}</span>
                  </div>
                  <div className="bg-slate-900/60 p-2.5 rounded-xl border border-slate-800/60">
                    <span className="text-slate-400 text-[10px] block" title="Зважена оцінка якості, не статистична ймовірність успіху">Якість сетапу</span>
                    <span className="font-bold text-cyan-400 font-mono">{formation.confidence}/100</span>
                  </div>
                </div>

                {/* Trade Setup Matrix */}
                <div className="space-y-2 pt-2 border-t border-slate-800">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Торгові рівні (Setup)
                  </span>

                  <div className="space-y-1.5 text-xs font-mono">
                    <div className="flex items-center justify-between p-2 rounded-lg bg-sky-950/30 border border-sky-900/40">
                      <span className="text-sky-300 font-sans flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-sky-400" />
                        Точка входу (Entry):
                      </span>
                      <span className="font-bold text-white">{formation.tpSlBuilder?.touches?.ready === false
                        ? `Очікується (${formation.tpSlBuilder.touches.count}/${formation.tpSlBuilder.touches.required})`
                        : String.fromCharCode(36) + formatPrice(formation.levels.entryPrice)}</span>
                    </div>

                    <div className="flex items-center justify-between p-2 rounded-lg bg-emerald-950/30 border border-emerald-900/40">
                      <span className="text-emerald-300 font-sans flex items-center gap-1.5">
                        <Target className="w-3.5 h-3.5 text-emerald-400" />
                        Ціль (Take Profit):
                      </span>
                      <div className="text-right">
                        <span className="font-bold text-emerald-400">${formatPrice(formation.levels.targetPrice)}</span>
                        <span className="text-[10px] text-emerald-300 ml-1.5">
                          {formation.status === 'target_reached' ? `(Досягнуто +${formation.potentialProfitPct}%)` : `(+${formation.potentialProfitPct}%)`}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between p-2 rounded-lg bg-rose-950/30 border border-rose-900/40">
                      <span className="text-rose-300 font-sans flex items-center gap-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                        Стоп-лос (Stop Loss):
                      </span>
                      <div className="text-right">
                        <span className="font-bold text-rose-400">${formatPrice(formation.levels.stopLossPrice)}</span>
                        <span className="text-[10px] text-rose-300 ml-1.5">(-{Math.abs(formation.potentialRiskPct)}%)</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900 border border-slate-800">
                      <span className="text-slate-400 font-sans">Співвідношення Risk / Reward:</span>
                      <span className="font-bold text-cyan-300 text-sm">1 : {formation.riskRewardRatio}</span>
                    </div>
                  </div>
                </div>

                {/* Telegram Price Alerts Quick Box */}
                <div className="p-3.5 rounded-xl bg-sky-950/30 border border-sky-500/30 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-sky-300 flex items-center gap-1.5">
                      <Send className="w-3.5 h-3.5 text-sky-400" />
                      Сповіщення в Telegram
                    </span>
                    {!user ? (
                      <span className="text-[10px] text-amber-300 bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded flex items-center gap-1 font-medium">
                        <Lock className="w-3 h-3 text-amber-400" /> Тільки для зареєстрованих
                      </span>
                    ) : alertFeedback ? (
                      <span className="text-[10px] text-emerald-300 font-semibold animate-pulse">
                        {alertFeedback}
                      </span>
                    ) : (
                      <button
                        onClick={() =>
                          onOpenTelegramModal?.({
                            symbol: coin.symbol,
                            exchange: coin.exchange,
                            marketType: coin.marketType,
                            currentPrice: livePrice,
                            targetPrice: formation.levels.targetPrice,
                            formationName: formation.name,
                          })
                        }
                        className="text-[10px] text-sky-400 hover:text-sky-300 underline font-medium cursor-pointer"
                      >
                        Керувати
                      </button>
                    )}
                  </div>

                  {!user ? (
                    <div className="p-3 rounded-lg bg-slate-900/90 border border-slate-800 text-center space-y-2">
                      <p className="text-[11px] text-slate-300 leading-relaxed">
                        Встановлення сповіщень у Telegram на точки входу, тейк-профіт та стоп-лосс доступне тільки зареєстрованим користувачам.
                      </p>
                      {onOpenAuth && (
                        <button
                          type="button"
                          onClick={onOpenAuth}
                          className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-bold text-xs inline-flex items-center gap-1.5 transition-all shadow cursor-pointer"
                        >
                          <LogIn className="w-3.5 h-3.5" />
                          <span>Увійти / Зареєструватися</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      {/* 3 Quick Buttons: Entry, Target, Stop Loss */}
                      <div className="grid grid-cols-3 gap-1.5 text-xs">
                        <button
                          type="button"
                          onClick={() => handleSetAlert('entry', formation.levels.entryPrice)}
                          disabled={settingAlert !== null}
                          className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-sky-500/50 text-slate-300 hover:text-white transition-all text-center cursor-pointer group disabled:opacity-50"
                          title="Надіслати в Telegram, коли ціна досягне точки входу"
                        >
                          <div className="text-[10px] text-sky-400 font-medium group-hover:text-sky-300 flex items-center justify-center gap-1">
                            <Bell className="w-2.5 h-2.5" /> Вхід
                          </div>
                          <div className="font-mono font-bold text-[11px] text-white mt-0.5">
                            ${formatPrice(formation.levels.entryPrice)}
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSetAlert('target', formation.levels.targetPrice)}
                          disabled={settingAlert !== null}
                          className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-emerald-500/50 text-slate-300 hover:text-white transition-all text-center cursor-pointer group disabled:opacity-50"
                          title="Надіслати в Telegram, коли ціна досягне тейк-профіту"
                        >
                          <div className="text-[10px] text-emerald-400 font-medium group-hover:text-emerald-300 flex items-center justify-center gap-1">
                            <Target className="w-2.5 h-2.5" /> Тейк
                          </div>
                          <div className="font-mono font-bold text-[11px] text-white mt-0.5">
                            ${formatPrice(formation.levels.targetPrice)}
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSetAlert('stop_loss', formation.levels.stopLossPrice)}
                          disabled={settingAlert !== null}
                          className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-rose-500/50 text-slate-300 hover:text-white transition-all text-center cursor-pointer group disabled:opacity-50"
                          title="Надіслати в Telegram, коли ціна досягне стоп-лосу"
                        >
                          <div className="text-[10px] text-rose-400 font-medium group-hover:text-rose-300 flex items-center justify-center gap-1">
                            <ShieldAlert className="w-2.5 h-2.5" /> Стоп
                          </div>
                          <div className="font-mono font-bold text-[11px] text-white mt-0.5">
                            ${formatPrice(formation.levels.stopLossPrice)}
                          </div>
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={handleSetAllAlerts}
                        disabled={settingAlert !== null}
                        className="w-full py-1.5 px-2.5 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/30 text-sky-300 hover:text-sky-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>{settingAlert === 'all' ? 'Встановлення...' : 'Встановити всі 3 рівні в Telegram'}</span>
                      </button>
                    </>
                  )}
                </div>

                {/* AI Analysis Trigger Button */}
                <button
                  onClick={handleRequestAi}
                  disabled={loadingAi}
                  className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-cyan-950/40 transition-all cursor-pointer"
                >
                  <Sparkles className={`w-4 h-4 ${loadingAi ? 'animate-spin' : ''}`} />
                  <span>{loadingAi ? 'Аналізуємо патерн...' : 'Інституційний Аналіз'}</span>
                </button>

              </div>
  );

  return (
    <>
      {!isFullscreenChartOpen && (
    <div className={pageMode
      ? 'relative w-full min-h-0 bg-[#070a12] pb-4 sm:pb-6'
      : 'fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4 md:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto no-scrollbar'}>
      <div className={pageMode
        ? 'relative mx-auto flex w-full max-w-6xl flex-col bg-slate-900 shadow-2xl sm:my-4 sm:rounded-3xl sm:border sm:border-slate-800 2xl:max-w-7xl'
        : 'relative w-full max-w-6xl 2xl:max-w-7xl bg-slate-900 border-0 sm:border border-slate-800 rounded-none sm:rounded-3xl shadow-2xl overflow-hidden my-auto min-h-screen sm:min-h-0 sm:max-h-[95vh] flex flex-col'}>
        {/* Compact chart header: title and price above, exchange next to the formation below. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 border-b border-slate-800 bg-slate-950/80 px-3 py-2.5 sticky top-0 z-20 sm:flex sm:justify-between sm:gap-3 sm:px-6 sm:py-4">
          <div className="contents sm:flex sm:min-w-0 sm:flex-1 sm:flex-wrap sm:items-center sm:gap-2">
            <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 sm:gap-2">
              {/* Keep the live-quote status visible without using a separate header row. */}
              <div
                role="status"
                aria-label={`Котирування: ${liveStatus.isConnected ? 'підключено' : 'немає підключення'} (${liveStatus.mode.toUpperCase()})`}
                title={`Котирування: ${liveStatus.isConnected ? 'підключено' : 'немає підключення'} (${liveStatus.mode.toUpperCase()})`}
                className={`flex shrink-0 items-center justify-center gap-1 rounded-full border px-1.5 py-1 transition-colors ${
                  liveStatus.isConnected
                    ? 'bg-emerald-950/70 border-emerald-700/60 text-emerald-300'
                    : 'bg-slate-800/80 border-slate-700 text-slate-400'
                }`}
              >
                <span className="relative flex h-2 w-2">
                  {liveStatus.isConnected && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  )}
                  <span className={`relative inline-flex h-2 w-2 rounded-full ${
                    liveStatus.isConnected ? 'bg-emerald-500' : 'bg-slate-500'
                  }`} />
                </span>
                {liveStatus.mode === 'ws' && <span aria-hidden="true" className="text-[10px] leading-none">⚡</span>}
              </div>
              <h2 className="shrink-0 whitespace-nowrap text-base font-extrabold tracking-wide text-white font-mono sm:text-xl">
                <CopyableCoinSymbol baseAsset={coin.baseAsset} quoteAsset={coin.quoteAsset} />
              </h2>
              <div className="inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap" aria-label="Поточна ціна та зміна за 24 години">
                <span className="font-mono text-[11px] font-bold text-white sm:text-sm">${formatPrice(livePrice)}</span>
                <span className={`text-[10px] font-semibold sm:text-xs ${coin.priceChange24h >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  ({coin.priceChange24h >= 0 ? '+' : ''}{coin.priceChange24h.toFixed(2)}%)
                </span>
              </div>

            </div>
            <div className="col-start-1 row-start-2 flex min-w-0 max-w-full items-center gap-1.5">
                {/* Switching patterns in the detailed view updates chart, levels and analysis without reopening it. */}
                {onFormationChange && formationOptions.length > 1 ? (
                  <div className="relative min-w-0 w-full max-w-[200px] sm:w-auto sm:max-w-[280px]">
                    <select
                      value={formation.id}
                      onChange={(event) => {
                        const next = formationOptions.find((item) => item.id === event.target.value);
                        if (next) onFormationChange(next);
                      }}
                      aria-label={`Вибрати формацію для ${coin.baseAsset}/${coin.quoteAsset}`}
                      title={`Знайдено ${formationOptions.length} формацій — натисніть, щоб змінити`}
                      className={`w-full min-w-0 appearance-none truncate rounded-lg border py-1 pl-2 pr-7 text-[10px] sm:text-[11px] font-semibold cursor-pointer outline-none focus:ring-1 focus:ring-cyan-400 ${
                        isBullish
                          ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'
                          : isBearish
                          ? 'bg-rose-500/20 text-rose-200 border-rose-500/40'
                          : 'bg-amber-500/20 text-amber-200 border-amber-500/40'
                      }`}
                    >
                      {formationOptions.map((item) => (
                        <option key={item.id} value={item.id} className="bg-slate-900 text-slate-100">
                          {item.name} · {item.bias === 'bullish' ? 'LONG' : item.bias === 'bearish' ? 'SHORT' : 'NEUTRAL'} · {item.confidence}/100
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-200" />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const el = document.getElementById('formation-trade-setup-card');
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    className={`flex min-w-0 max-w-full items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-0.5 rounded-full border text-[10px] sm:text-[11px] font-semibold transition-all cursor-pointer shadow-sm ${
                      isBullish
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30'
                        : isBearish
                        ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30'
                        : 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                    }`}
                    title={`Формація: ${formation.name} (${formation.statusLabel})`}
                  >
                    <span className="text-[9px] sm:text-[10px] font-black">{isBullish ? '▲' : isBearish ? '▼' : '◆'}</span>
                    <span className="min-w-0 truncate font-medium tracking-tight">{formation.name.replace(/\s*\(Підтримка\)\s*$/iu, '')}</span>
                  </button>
                )}
                <span
                  className={`shrink-0 text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 rounded font-bold uppercase ${
                    coin.exchange === 'binance'
                      ? 'bg-amber-500/10 text-amber-300 border border-amber-500/30'
                      : 'bg-orange-500/10 text-orange-300 border border-orange-500/30'
                  }`}
                >
                  {coin.exchange}
                </span>
            </div>
          </div>
          <div className="col-start-2 row-start-2 flex shrink-0 items-center justify-self-end gap-1.5 sm:gap-2">
            {/* Telegram Alerts button */}
            <button
              onClick={() =>
                onOpenTelegramModal?.({
                  symbol: coin.symbol,
                  exchange: coin.exchange,
                  marketType: coin.marketType,
                  currentPrice: livePrice,
                  targetPrice: formation.levels.targetPrice,
                  formationName: formation.name,
                })
              }
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 hover:text-sky-100 border border-sky-500/40 text-xs font-semibold transition-all active:scale-95 shadow-sm whitespace-nowrap cursor-pointer"
              title="Налаштувати сповіщення в Telegram"
            >
              <Send className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sky-400" />
            </button>

            {onSendMetaScalp && (
              <button
                onClick={() => onSendMetaScalp(coin)}
                className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 hover:text-amber-100 border border-amber-500/40 text-xs font-semibold transition-all active:scale-95 shadow-sm whitespace-nowrap cursor-pointer"
                title={`Відкрити в обраному терміналі (Група ${metaScalpBinding})`}
              >
                <Zap className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-400 fill-amber-400/30" />
                <span className="font-mono text-[10px] px-1 rounded bg-amber-500/20 text-amber-200">
                  {metaScalpBinding}
                </span>
              </button>
            )}

            {/* Return to Main Menu button */}
            <button
              onClick={onClose}
              className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-1.5 sm:py-2 rounded-xl bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 hover:text-cyan-100 border border-cyan-500/40 text-xs sm:text-sm font-semibold transition-all active:scale-95 shadow-sm whitespace-nowrap cursor-pointer"
              title="Повернутися в головне меню"
            >
              <ArrowLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span className="sm:hidden">Назад</span>
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className={pageMode ? 'min-w-0 space-y-4 p-3 sm:space-y-6 sm:p-6' : 'p-3 sm:p-6 overflow-y-auto no-scrollbar space-y-4 sm:space-y-6'}>
          {/* Main Grid: Left Chart, Right Setup Details */}
          <div className="grid grid-cols-1 gap-4 sm:gap-6">
            {/* Left: Chart & Timeframe switch (col-span-2) */}
            <div ref={chartSectionRef} tabIndex={-1} className="space-y-3 outline-none">
              {/* Real-time Analysis Plain Text without borders, dependent on chart timeframe */}
              <ChartTopAnalysisText
                coin={coin}
                formation={formation}
                klines={klines}
                livePrice={livePrice}
                timeframe={timeframe}
                onTimeframeChange={tf => { setTimeframe(tf); onPageTimeframeChange?.(tf); }}
              />

              {loadingKlines ? (
                <div className="w-full h-[220px] xs:h-[260px] sm:h-[300px] md:h-[350px] lg:h-[390px] xl:h-[430px] rounded-xl border border-slate-800 bg-slate-950 flex flex-col items-center justify-center text-slate-400 gap-2">
                  <RefreshCw className="w-6 h-6 animate-spin text-cyan-400" />
                  <span className="text-xs">Завантаження свічок з біржі...</span>
                </div>
              ) : (
                <TradingViewChart
                  visualContext={visualOrigin === 'screener' ? 'screenerQuick' : 'formationsQuick'}
                  klines={klines}
                  formation={formation}
                  symbol={`${coin.symbol}`}
                  timeframe={timeframe}
                  exchange={coin.exchange}
                  marketType={coin.marketType}
                  historyLimit={historyLimit}
                  onHistoryLimitChange={setHistoryLimit}
                  onTimeframeChange={tf => { setTimeframe(tf); onPageTimeframeChange?.(tf); }}
                  onLivePriceUpdate={setLivePrice}
                  onCrosshairPriceChange={handleCrosshairAlertPrice}
                  hideHeaderLiveIndicator={true}
                  hideHeaderFormationBadge={true}
                  hideSymbolAndPrice={true}
                  onLiveStatusChange={setLiveStatus}
                  onOpenFullscreen={() => setIsFullscreenChartOpen(true)}
                  onAddToArchive={handleSaveToArchive}
                  isArchived={alreadyArchived}
                  isSavingArchive={isSavingArchive}
                  customMarkers={archivedItem?.markers}
                  savedChartParams={archivedItem?.chartParams}
                />
              )}

              {/* Custom Price Alert Section Below Chart */}
              <div className={telegramAlertPanelCollapsed
                ? 'flex w-full min-w-0 flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/90 p-3 sm:p-4'
                : 'w-full space-y-4 rounded-2xl border border-slate-800 bg-slate-950/90 p-4 sm:p-5'}>
                <div className={telegramAlertPanelCollapsed
                  ? 'relative flex w-full min-w-0 items-center gap-2 sm:gap-3'
                  : 'relative flex w-full min-w-0 items-start gap-2 sm:gap-3'}>
                  <div className={telegramAlertPanelCollapsed
                    ? 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-cyan-400'
                    : 'shrink-0 rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-2 text-cyan-400'}>
                    <Bell className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className={telegramAlertPanelCollapsed
                      ? 'min-w-0 truncate text-xs font-bold leading-7 text-white sm:text-sm'
                      : 'text-xs font-bold leading-7 text-white sm:text-sm'}>
                      Сповіщення Telegram
                    </h4>
                    {!telegramAlertPanelCollapsed && (
                      <p className="text-xs text-slate-400">
                        Вкажіть будь-яку ціну, при досягненні якої бот надішле миттєвий сигнал
                      </p>
                    )}
                  </div>
                  <div className="ml-auto mr-9 inline-flex shrink-0 items-center gap-1.5">
                    <span className="rounded-full border border-cyan-800/60 bg-cyan-950/80 px-2 py-0.5 font-mono text-[10px] text-cyan-300">
                      {coin.symbol}
                    </span>
                  </div>
                  <button
                      type="button"
                      onClick={toggleTelegramAlertPanel}
                      aria-expanded={!telegramAlertPanelCollapsed}
                      aria-controls="telegram-price-alert-panel-details"
                      aria-label={telegramAlertPanelCollapsed ? 'Розгорнути сповіщення Telegram' : 'Згорнути сповіщення Telegram'}
                      title={telegramAlertPanelCollapsed ? 'Розгорнути' : 'Згорнути'}
                      className={`absolute right-0 top-0 inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-300 transition-colors hover:border-cyan-600 hover:text-cyan-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 ${telegramAlertPanelCollapsed ? 'h-8 w-8' : 'h-7 w-7'}`}
                    >
                      {telegramAlertPanelCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                    </button>
                </div>
                {/* Telegram status badge: keep it below the header so the coin and
                    collapse control stay anchored at the top right on mobile. */}
                {!telegramAlertPanelCollapsed && isTelegramConfigured === false && onOpenTelegramModal && (
                  <button
                    type="button"
                    onClick={() => onOpenTelegramModal({ symbol: coin.symbol })}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300 transition-colors hover:bg-amber-500/20"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>Підключити Telegram-бота</span>
                  </button>
                )}
                {!telegramAlertPanelCollapsed && isTelegramConfigured && (
                  <div className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span>Бот підключено</span>
                  </div>
                )}
                {telegramAlertPanelSaveError && (
                  <p role="status" className="text-xs text-amber-300">
                    Не вдалося синхронізувати стан блоку з профілем. Налаштування залишиться локальним у цьому браузері.
                  </p>
                )}

                <div id="telegram-price-alert-panel-details" className={telegramAlertPanelCollapsed ? 'hidden' : 'space-y-4'}>
                {/* Form controls */}
                <form onSubmit={handleCreateCustomAlert} className="space-y-3">
                  {/* Quick Delta Buttons */}
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-slate-400 text-[11px] mr-1">Швидкий вибір:</span>
                    <button
                      type="button"
                      onClick={() => applyPercentDelta(0)}
                      className="px-2 py-1 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 text-xs font-mono transition-colors"
                    >
                      Поточна (${formatPrice(livePrice || coin.currentPrice)})
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPercentDelta(0.5)}
                      className="px-2 py-1 rounded-md bg-emerald-950/50 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/40 text-xs font-mono transition-colors"
                    >
                      +0.5%
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPercentDelta(1)}
                      className="px-2 py-1 rounded-md bg-emerald-950/50 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/40 text-xs font-mono transition-colors"
                    >
                      +1%
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPercentDelta(2)}
                      className="px-2 py-1 rounded-md bg-emerald-950/50 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/40 text-xs font-mono transition-colors"
                    >
                      +2%
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPercentDelta(5)}
                      className="px-2 py-1 rounded-md bg-emerald-950/50 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/40 text-xs font-mono transition-colors"
                    >
                      +5%
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPercentDelta(-0.5)}
                      className="px-2 py-1 rounded-md bg-rose-950/50 hover:bg-rose-900/60 text-rose-300 border border-rose-800/40 text-xs font-mono transition-colors"
                    >
                      -0.5%
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPercentDelta(-1)}
                      className="px-2 py-1 rounded-md bg-rose-950/50 hover:bg-rose-900/60 text-rose-300 border border-rose-800/40 text-xs font-mono transition-colors"
                    >
                      -1%
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPercentDelta(-2)}
                      className="px-2 py-1 rounded-md bg-rose-950/50 hover:bg-rose-900/60 text-rose-300 border border-rose-800/40 text-xs font-mono transition-colors"
                    >
                      -2%
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPercentDelta(-5)}
                      className="px-2 py-1 rounded-md bg-rose-950/50 hover:bg-rose-900/60 text-rose-300 border border-rose-800/40 text-xs font-mono transition-colors"
                    >
                      -5%
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                    {/* Price Input */}
                    <div className="sm:col-span-4">
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                        Цільова ціна ($)
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 font-mono text-sm">
                          $
                        </span>
                        <input
                          ref={customAlertPriceInputRef}
                          type="number"
                          step="any"
                          value={customAlertPrice}
                          onChange={(e) => handleCustomPriceChange(e.target.value)}
                          placeholder={String(livePrice || coin.currentPrice)}
                          className="w-full pl-7 pr-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-white font-mono text-sm placeholder-slate-600 focus:outline-none focus:border-cyan-500 transition-colors"
                          required
                        />
                      </div>
                    </div>

                    {/* Condition toggle */}
                    <div className="sm:col-span-3">
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                        Умова спрацювання
                      </label>
                      <div className="grid grid-cols-2 gap-1 p-1 bg-slate-900 border border-slate-700 rounded-xl">
                        <button
                          type="button"
                          onClick={() => setCustomAlertCondition('gte')}
                          className={`py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-colors ${
                            customAlertCondition === 'gte'
                              ? 'bg-emerald-500 text-white font-bold shadow'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <ArrowUpRight className="w-3.5 h-3.5" />
                          <span>≥ Ріст</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setCustomAlertCondition('lte')}
                          className={`py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-colors ${
                            customAlertCondition === 'lte'
                              ? 'bg-rose-500 text-white font-bold shadow'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <ArrowDownRight className="w-3.5 h-3.5" />
                          <span>≤ Спад</span>
                        </button>
                      </div>
                    </div>

                    {/* Note Input */}
                    <div className="sm:col-span-3">
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                        Нотатка (необов'язково)
                      </label>
                      <input
                        type="text"
                        value={customAlertNote}
                        onChange={(e) => setCustomAlertNote(e.target.value)}
                        placeholder="Напр. Тест рівня, пробій..."
                        className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-white text-xs placeholder-slate-600 focus:outline-none focus:border-cyan-500 transition-colors"
                      />
                    </div>

                    {/* Submit Button */}
                    <div className="sm:col-span-2">
                      <button
                        type="submit"
                        disabled={settingCustomAlert || !customAlertPrice}
                        className="w-full py-2 px-3 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-cyan-500/20 flex items-center justify-center gap-1.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {settingCustomAlert ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Plus className="w-4 h-4" />
                            <span>Додати</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Feedback messages */}
                  {customAlertSuccess && (
                    <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                      <span>{customAlertSuccess}</span>
                    </div>
                  )}
                  {customAlertError && (
                    <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                      <span>{customAlertError}</span>
                    </div>
                  )}
                </form>

                {/* List of active alerts for this coin */}
                {coinAlerts.length > 0 && (
                  <div className="pt-2 border-t border-slate-800/80 space-y-2">
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span className="font-semibold">Встановлені сповіщення для {coin.symbol}:</span>
                      <span className="font-mono text-cyan-400 font-bold">{coinAlerts.length}</span>
                    </div>
                    <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                      {coinAlerts.map((a) => (
                        <div
                          key={a.id}
                          className={`flex items-center justify-between gap-2 p-2 rounded-xl border text-xs ${
                            a.triggered
                              ? 'bg-slate-900/50 border-slate-800 text-slate-400'
                              : a.isActive
                              ? 'bg-slate-900 border-slate-700/80 text-white'
                              : 'bg-slate-950 border-slate-800/50 text-slate-500'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`p-1 rounded font-mono text-[10px] font-bold ${
                                a.condition === 'gte'
                                  ? 'bg-emerald-500/20 text-emerald-300'
                                  : 'bg-rose-500/20 text-rose-300'
                              }`}
                            >
                              {a.condition === 'gte' ? '≥' : '≤'}
                            </span>
                            <span className="font-mono font-bold text-white">
                              ${formatPrice(a.targetPrice)}
                            </span>
                            {a.note && (
                              <span className="text-[11px] text-slate-400 truncate max-w-[140px] sm:max-w-[200px]">
                                ({a.note})
                              </span>
                            )}
                            {a.triggered && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-semibold">
                                Спрацював (${formatPrice(a.triggeredPrice || a.targetPrice)})
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {!a.triggered && (
                              <button
                                type="button"
                                onClick={() => handleToggleCoinAlert(a.id)}
                                title={a.isActive ? 'Призупинити' : 'Активувати'}
                                className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                              >
                                {a.isActive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDeleteCoinAlert(a.id)}
                              title="Видалити"
                              className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                </div>
              </div>
            </div>

          </div>

          {/* AI Analysis Section */}
          {aiAnalysis && (
            <div className="p-6 rounded-2xl bg-gradient-to-b from-slate-900 to-slate-950 border border-cyan-900/40 space-y-4">
              <div className="flex items-center gap-2 text-cyan-400">
                <Sparkles className="w-5 h-5" />
                <h4 className="text-sm font-bold uppercase tracking-wider">
                  Інституційний Розбір Формації
                </h4>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                {/* Summary & Confirmation */}
                <div className="space-y-3 bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                  <div>
                    <span className="font-semibold text-slate-300 block mb-1 text-xs">Резюме позиції:</span>
                    <p className="text-slate-300 leading-relaxed">{aiAnalysis.summary}</p>
                  </div>
                  <div>
                    <span className="font-semibold text-cyan-300 block mb-1 text-xs">Підтвердження формації:</span>
                    <p className="text-slate-400 leading-relaxed">{aiAnalysis.patternConfirmation}</p>
                  </div>
                </div>

                {/* Targets & Invalidation */}
                <div className="space-y-3 bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                  <div>
                    <span className="font-semibold text-emerald-400 block mb-1 text-xs">Аналіз ліквідності та цілей:</span>
                    <p className="text-slate-300 leading-relaxed">{aiAnalysis.targetAnalysis}</p>
                  </div>
                  <div>
                    <span className="font-semibold text-rose-400 block mb-1 text-xs">Критерій інвалідації (Скасування):</span>
                    <p className="text-slate-400 leading-relaxed">{aiAnalysis.invalidationCriteria}</p>
                  </div>
                </div>
              </div>

              {/* Qualitative analysis never overrides the canonical detected setup. */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                <p className="text-[11px] text-slate-400">
                  Інституційний аналіз пояснює ризики. Єдині торгові рівні Entry / TP / SL
                  наведені у блоці «Виявлена формація» — альтернативних цін тут немає.
                </p>

                {/* Key Risks */}
                {aiAnalysis.keyRisks && aiAnalysis.keyRisks.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-800/80">
                    <span className="text-[11px] font-semibold text-amber-300 flex items-center gap-1 mb-1">
                      <AlertTriangle className="w-3 h-3 text-amber-400" />
                      Ключові ризики:
                    </span>
                    <ul className="list-disc list-inside text-slate-400 text-xs space-y-0.5">
                      {aiAnalysis.keyRisks.map((risk, idx) => (
                        <li key={idx}>{risk}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Global, persistent Smart Analysis accordion. Only its UI is hidden;
              no Telegram alert or trading setting is changed. */}
          <div className="relative w-full min-w-0">
            {smartAnalysisCollapsed ? (
              <div className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-indigo-500/30 bg-slate-950/90 p-3 sm:p-4">
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-indigo-500/40 bg-indigo-500/20 text-indigo-400">
                  <Zap className="h-4 w-4 fill-current" />
                </span>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <h4 className="min-w-0 text-xs font-bold uppercase tracking-wide text-white sm:text-sm">
                    РОЗУМНИЙ АНАЛІЗ
                  </h4>
                  <span className="shrink-0 rounded-full border border-indigo-500/40 bg-indigo-500/20 px-2 py-0.5 font-mono text-[10px] font-bold text-indigo-300">
                    AI + Quant
                  </span>
                </div>
                <button
                  type="button"
                  onClick={toggleSmartAnalysis}
                  aria-expanded={false}
                  aria-label="Розгорнути Розумний аналіз AI + Quant"
                  title="Розгорнути Розумний аналіз"
                  className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-indigo-500/40 bg-slate-900 text-slate-300 transition-colors hover:text-indigo-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <>
                <SmartAnalysisBlock coin={coin} formation={formation} klines={klines} timeframe={timeframe} tradeSetup={tradeSetupPanel} onCollapse={toggleSmartAnalysis} />
              </>
            )}
            {smartAnalysisSaveError && (
              <p role="status" className="mt-2 text-xs text-amber-300">
                Не вдалося синхронізувати згортання аналізу з профілем. Вибір збережено в цьому браузері.
              </p>
            )}
          </div>
        </div>
        {/* Same localized legal/contact footer as the main Screener page. */}
        <SiteFooter />
      </div>

    </div>
      )}

      {/* Interactive Fullscreen Chart Modal */}
      <FullscreenChartModal
        isOpen={isFullscreenChartOpen}
        visualContext={visualOrigin === 'screener' ? 'screenerFull' : 'formationsFull'}
        onClose={() => setIsFullscreenChartOpen(false)}
        coin={coin}
        formation={formation}
        klines={klines}
        currentTimeframe={timeframe}
        onTimeframeChange={tf => { setTimeframe(tf); onPageTimeframeChange?.(tf); }}
        livePrice={livePrice}
        onOpenTelegramModal={onOpenTelegramModal}
        onSendMetaScalp={onSendMetaScalp}
        metaScalpBinding={metaScalpBinding}
        onAddToArchive={handleSaveToArchive}
        isArchived={alreadyArchived}
        customMarkers={archivedItem?.markers}
        savedChartParams={archivedItem?.chartParams}
        allCoins={allCoins}
        watchlist={watchlist}
        onToggleWatchlist={onToggleWatchlist}
      />
    </>
  );
};
