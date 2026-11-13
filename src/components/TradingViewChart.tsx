import { normalizeExchangeSymbol } from '../utils/marketSymbols';
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  createChart,
  CandlestickSeries,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  Time,
  LineStyle,
  IPriceLine,
  CrosshairMode,
} from 'lightweight-charts';
import {
  Maximize2,
  ZoomIn,
  Activity,
  Clock,
  Expand,
  CheckCircle2,
  BarChart3,
  Target,
  ChevronUp,
} from 'lucide-react';
import { FormationArchiveIcon } from './FormationArchiveIcon';
import { Kline, DetectedFormation, Timeframe, ExchangeId, MarketType, ChartMarkerInfo, ChartRestoreParams } from '../types';
import { getChartPriceFormat, formatCryptoPrice } from '../utils/formatters';
import { fetchDirectKlines } from '../utils/directExchangeClient';
import { useAuth } from '../context/AuthContext';
import { useChartProvider } from '../utils/useChartProvider';
import { filterVisibleTradeMarkers, formationChartMarkers, hasCompleteTradeLevelSet, mergeLiveCandle, toggleCombinedTradeLevels } from '../utils/hookchartData';
import { CHART_TRADE_LEVELS_EVENT, chartTradeLevelStorageKey, normalizeChartTradeLevelVisibility, readChartTradeLevels, saveChartTradeLevels, type ChartTradeLevelVisibility } from '../utils/chartTradeLevelPreferences';
import { HookChart } from './HookChart';
import type { TerminalToolbarVisibility } from './hookchart/HookChartCanvas';
import type { HookChartHandle } from './hookchart/engine';
import { subscribeSharedKlines } from './hookchart/sharedKlineStream';
import { subscribeMarketTrades } from './hookchart/marketTradeStream';
import { fetchSharedLiveFallbackKline, shouldApplyLiveFallbackKline } from './hookchart/sharedLiveFallback';
import type { VisualChartProfile, VisualContextId } from './hookchart/visualProfiles';

interface TradingViewChartProps {
  klines: Kline[];
  formation?: DetectedFormation | null;
  symbol: string;
  timeframe: string;
  exchange?: ExchangeId;
  marketType?: MarketType;
  historyLimit?: number;
  onHistoryLimitChange?: (limit: number) => void;
  onTimeframeChange?: (timeframe: Timeframe) => void;
  onLivePriceUpdate?: (price: number) => void;
  /** Optional price under the chart crosshair, for an expanded Telegram alert form. */
  onCrosshairPriceChange?: (price: number) => void;
  /** Called at most once when a new candle starts; reuses the existing chart feed. */
  onClosedCandle?: (candle: Kline) => void;
  onOpenFullscreen?: () => void;
  onAddToArchive?: () => void;
  isArchived?: boolean;
  isSavingArchive?: boolean;
  customMarkers?: ChartMarkerInfo[];
  /** Provisional W/M levels are a chart preview, independent of saved TP/SL visibility. */
  previewMarkers?: boolean;
  /** Always render the native HookChart in fullscreen, regardless of legacy provider settings. */
  forceHookChart?: boolean;
  savedChartParams?: ChartRestoreParams;
  fullHeight?: boolean;
  showNavigationControls?: boolean;
  hideHeaderLiveIndicator?: boolean;
  hideHeaderFormationBadge?: boolean;
  hideSymbolAndPrice?: boolean;
  terminalMode?: boolean;
  terminalAutoScale?: boolean;
  terminalInitialView?: VisualChartProfile;
  visualContext?: VisualContextId;
  terminalToolbarVisibility?: TerminalToolbarVisibility;
  hookchartToolbarActions?: React.ReactNode;
  hookchartToolbarOverlays?: React.ReactNode;
  onLiveStatusChange?: (status: { isConnected: boolean; mode: 'ws' | 'rest' }) => void;
}

// Calculate remaining time until the active candle closes based on the timeframe
function calculateBarCloseCountdown(tf: string): { totalSeconds: number; formatted: string; isUrgent: boolean } {
  const now = Date.now();
  let durationMs: number;
  let nextCloseMs: number;

  switch (tf) {
    case '1m':
      durationMs = 60 * 1000;
      nextCloseMs = Math.ceil(now / durationMs) * durationMs;
      break;
    case '5m':
      durationMs = 5 * 60 * 1000;
      nextCloseMs = Math.ceil(now / durationMs) * durationMs;
      break;
    case '15m':
      durationMs = 15 * 60 * 1000;
      nextCloseMs = Math.ceil(now / durationMs) * durationMs;
      break;
    case '30m':
      durationMs = 30 * 60 * 1000;
      nextCloseMs = Math.ceil(now / durationMs) * durationMs;
      break;
    case '1h':
      durationMs = 60 * 60 * 1000;
      nextCloseMs = Math.ceil(now / durationMs) * durationMs;
      break;
    case '4h':
      durationMs = 4 * 60 * 60 * 1000;
      nextCloseMs = Math.ceil(now / durationMs) * durationMs;
      break;
    case '1d': {
      // Closes at UTC 00:00:00
      const d = new Date(now);
      const nextDayUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
      nextCloseMs = nextDayUtc;
      durationMs = 24 * 60 * 60 * 1000;
      break;
    }
    default:
      durationMs = 60 * 60 * 1000;
      nextCloseMs = Math.ceil(now / durationMs) * durationMs;
  }

  if (nextCloseMs <= now) {
    nextCloseMs += (durationMs || 60000);
  }

  const diffMs = Math.max(0, nextCloseMs - now);
  const totalSeconds = Math.floor(diffMs / 1000);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let formatted: string;
  if (hours > 0) {
    formatted = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  } else {
    formatted = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  // Urgent threshold when closing is imminent (triggers ticking animation)
  let urgentThreshold = 30;
  if (tf === '1m') urgentThreshold = 15;
  else if (tf === '5m') urgentThreshold = 30;
  else if (tf === '15m') urgentThreshold = 45;
  else if (tf === '1h') urgentThreshold = 90;
  else if (tf === '4h' || tf === '1d') urgentThreshold = 180;

  const isUrgent = totalSeconds <= urgentThreshold;
  return { totalSeconds, formatted, isUrgent };
}

export const TradingViewChart: React.FC<TradingViewChartProps> = ({
  klines,
  formation,
  symbol,
  timeframe,
  exchange = 'binance',
  marketType = 'futures',
  historyLimit = 1000,
  onHistoryLimitChange,
  onTimeframeChange,
  onLivePriceUpdate,
  onCrosshairPriceChange,
  onClosedCandle,
  onOpenFullscreen,
  onAddToArchive,
  isArchived,
  isSavingArchive,
  customMarkers,
  previewMarkers = false,
  forceHookChart = false,
  savedChartParams,
  fullHeight = false,
  showNavigationControls = true,
  hideHeaderLiveIndicator = false,
  hideHeaderFormationBadge = false,
  hideSymbolAndPrice = false,
  terminalMode = false,
  terminalAutoScale = false,
  terminalInitialView,
  visualContext = 'screenerQuick',
  terminalToolbarVisibility,
  hookchartToolbarActions,
  hookchartToolbarOverlays,
  onLiveStatusChange,
}) => {
  const { user, profile, updateProfileData } = useAuth();
  const savedChartProvider = useChartProvider();
  const chartProvider = forceHookChart ? 'hookchart' : savedChartProvider;
  const hookChartRef = useRef<HookChartHandle | null>(null);
  const onCrosshairPriceChangeRef = useRef(onCrosshairPriceChange);
  onCrosshairPriceChangeRef.current = onCrosshairPriceChange;
  const hookTickRef = useRef<Kline | null>(null);
  const hookTickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const lastTickTimeRef = useRef<number>(0);
  const latestPriceRef = useRef<number | null>(null);
  const currentCandleRef = useRef<{ time: number; open: number; high: number; low: number; close: number; volume?: number } | null>(null);
  const onClosedCandleRef = useRef(onClosedCandle);
  onClosedCandleRef.current = onClosedCandle;
  const lastNotifiedClosedRef = useRef<number>(0);
  const feedKeyRef = useRef([exchange, marketType, symbol, timeframe].join('|'));
  useEffect(() => {
    const key = [exchange, marketType, symbol, timeframe].join('|');
    if (key !== feedKeyRef.current) {
      feedKeyRef.current = key;
      lastNotifiedClosedRef.current = 0;
      // Never count a prior instrument's candle against this instrument's
      // personal wick rules during fullscreen symbol/timeframe switching.
      currentCandleRef.current = null;
    }
  }, [symbol, timeframe, exchange, marketType]);
  const rafIdRef = useRef<number | null>(null);
  const pendingUiPriceRef = useRef<{ price: number; direction: 'up' | 'down' | 'neutral' } | null>(null);
  const lastUiUpdateTimestampRef = useRef<number>(0);
  const klinesLengthRef = useRef<number>(klines.length);
  const hasInitiallyCenteredRef = useRef<boolean>(false);
  const prevSymbolRef = useRef<string>(symbol);

  useEffect(() => {
    if (prevSymbolRef.current !== symbol) {
      prevSymbolRef.current = symbol;
      hasInitiallyCenteredRef.current = false;
    }
  }, [symbol]);

  // Real-time state
  const [currentPrice, setCurrentPrice] = useState<number | null>(() => {
    return klines.length > 0 ? klines[klines.length - 1].close : null;
  });
  const [priceDirection, setPriceDirection] = useState<'up' | 'down' | 'neutral'>('neutral');
  const [isLiveConnected, setIsLiveConnected] = useState<boolean>(false);
  const [liveMode, setLiveMode] = useState<'ws' | 'rest'>('rest');
  const [tickAnimation, setTickAnimation] = useState<boolean>(false);

  useEffect(() => {
    onLiveStatusChange?.({ isConnected: isLiveConnected, mode: liveMode });
  }, [isLiveConnected, liveMode, onLiveStatusChange]);
  // A single, account-scoped choice governs Entry, TP and SL on all charts.
  // Profiles remain authoritative for signed-in users; local storage covers guests.
  const initialTradeLevels = readChartTradeLevels(user?.uid, profile?.chartLabelSettings);
  const [showEntryLevel, setShowEntryLevel] = useState<boolean>(initialTradeLevels.entry);
  const [showTargetLevel, setShowTargetLevel] = useState<boolean>(initialTradeLevels.target);
  const [showStopLevel, setShowStopLevel] = useState<boolean>(initialTradeLevels.stop);

  useEffect(() => {
    const restored = readChartTradeLevels(user?.uid, profile?.chartLabelSettings);
    setShowEntryLevel(restored.entry);
    setShowTargetLevel(restored.target);
    setShowStopLevel(restored.stop);
  }, [user?.uid, profile?.chartLabelSettings?.entry, profile?.chartLabelSettings?.target, profile?.chartLabelSettings?.stop]);

  // A page may render multiple HookCharts at once. Keep their buttons and
  // plotted levels in sync immediately, before the remote profile write returns.
  useEffect(() => {
    const accountKey = user?.uid || 'guest';
    const apply = (levels: ChartTradeLevelVisibility) => {
      setShowEntryLevel(levels.entry);
      setShowTargetLevel(levels.target);
      setShowStopLevel(levels.stop);
    };
    const onSharedChange = (event: Event) => {
      const detail = (event as CustomEvent<{ accountKey: string; levels: ChartTradeLevelVisibility }>).detail;
      if (!detail || detail.accountKey !== accountKey) return;
      const levels = normalizeChartTradeLevelVisibility(detail.levels);
      if (levels) apply(levels);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== chartTradeLevelStorageKey(user?.uid) || !event.newValue) return;
      try {
        const levels = normalizeChartTradeLevelVisibility(JSON.parse(event.newValue));
        if (levels) apply(levels);
      } catch {}
    };
    window.addEventListener(CHART_TRADE_LEVELS_EVENT, onSharedChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHART_TRADE_LEVELS_EVENT, onSharedChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [user?.uid]);

  const applyTradeLevels = useCallback((levels: ChartTradeLevelVisibility) => {
    setShowEntryLevel(levels.entry);
    setShowTargetLevel(levels.target);
    setShowStopLevel(levels.stop);
    saveChartTradeLevels(user?.uid, levels);
    window.dispatchEvent(new CustomEvent(CHART_TRADE_LEVELS_EVENT, {
      detail: { accountKey: user?.uid || 'guest', levels },
    }));
    if (user) {
      void updateProfileData({ chartLabelSettings: levels })
        .catch(error => console.error('Не вдалося зберегти TP/SL у профілі', error));
    }
  }, [user?.uid, updateProfileData]);

  // Bar Close Countdown state
  const [barCountdown, setBarCountdown] = useState<{ totalSeconds: number; formatted: string; isUrgent: boolean }>(() =>
    calculateBarCloseCountdown(timeframe)
  );
  const [tickPulse, setTickPulse] = useState<boolean>(false);

  useEffect(() => {
    const updateCountdown = () => {
      const countdown = calculateBarCloseCountdown(timeframe);
      setBarCountdown(countdown);
      if (countdown.isUrgent) {
        setTickPulse((prev) => !prev);
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [timeframe]);

  const [effectiveKlines, setEffectiveKlines] = useState<Kline[]>(klines);

  useEffect(() => {
    if (klines && klines.length > 1) {
      setEffectiveKlines(klines);
    }
  }, [klines]);

  // Self-healing: if parent passed <= 1 candle, fetch 1000 candles immediately
  useEffect(() => {
    if (effectiveKlines.length > 1) return;
    let isCancelled = false;

    async function loadFullHistory() {
      const cleanSym = normalizeExchangeSymbol(symbol);
      try {
        const res = await fetch(
          `/api/klines?exchange=${exchange}&market=${marketType}&symbol=${encodeURIComponent(cleanSym)}&timeframe=${timeframe}&limit=${historyLimit || 1000}`
        );
        const json = await res.json();
        if (!isCancelled && json.success && Array.isArray(json.data) && json.data.length > 1) {
          setEffectiveKlines(json.data);
          return;
        }

        const direct = await fetchDirectKlines(exchange, marketType, cleanSym, timeframe as Timeframe, historyLimit || 1000);
        if (!isCancelled && direct.length > 1) {
          setEffectiveKlines(direct);
        }
      } catch {
        try {
          const direct = await fetchDirectKlines(exchange, marketType, cleanSym, timeframe as Timeframe, historyLimit || 1000);
          if (!isCancelled && direct.length > 1) {
            setEffectiveKlines(direct);
          }
        } catch {}
      }
    }

    loadFullHistory();

    return () => {
      isCancelled = true;
    };
  }, [symbol, timeframe, exchange, marketType, historyLimit, effectiveKlines.length]);

  // Update latest price ref and initialize active candle
  useEffect(() => {
    if (effectiveKlines.length > 0) {
      const last = effectiveKlines[effectiveKlines.length - 1];
      setCurrentPrice((prev) => prev ?? last.close);
      latestPriceRef.current = last.close;
      currentCandleRef.current = {
        time: last.time,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
        volume: last.volume,
      };
    }
    klinesLengthRef.current = effectiveKlines.length;
  }, [effectiveKlines]);

  const hookMarkers = useMemo(() => {
    const visibility = { entry: showEntryLevel, target: showTargetLevel, stop: showStopLevel };
    const markers = customMarkers?.length ? customMarkers
      : formationChartMarkers(formation, visibility, timeframe as Timeframe);
    return previewMarkers ? markers : filterVisibleTradeMarkers(markers, visibility);
  }, [customMarkers, formation, showEntryLevel, showTargetLevel, showStopLevel, timeframe, previewMarkers]);
  const hasTradeLevels = hasCompleteTradeLevelSet(formation, customMarkers);

  useEffect(() => () => {
    if (hookTickTimer.current) clearTimeout(hookTickTimer.current);
    hookTickTimer.current = null;
    hookTickRef.current = null;
  }, [chartProvider, symbol, timeframe, exchange, marketType]);

  // Fit content helper
  const handleFitAll = useCallback(() => {
    if (chartProvider === 'hookchart') { hookChartRef.current?.fitContent(); return; }
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  }, [chartProvider]);

  // Focus / Center on recent candles and latest price action
  const centerChartOnScreen = useCallback(() => {
    if (chartProvider === 'hookchart') { hookChartRef.current?.zoomToLatest(); return; }
    if (!chartRef.current || !candleSeriesRef.current || klinesLengthRef.current === 0) return;
    const total = klinesLengthRef.current;

    // Always focus on recent / latest candles where the current price and formation are active
    const visibleBars = Math.min(65, total);
    const rightPadding = Math.round(visibleBars * 0.35); // ~22 bars forward space
    chartRef.current.timeScale().setVisibleLogicalRange({
      from: Math.max(0, total - visibleBars),
      to: total + rightPadding,
    });

    // Auto-scale vertical price scale with comfortable margins for centered focus
    try {
      chartRef.current.priceScale('right').applyOptions({
        autoScale: true,
        scaleMargins: {
          top: 0.12,
          bottom: 0.12,
        },
      });
    } catch {
      // Ignored
    }
  }, [chartProvider]);

  // Zoom to recent candles
  const handleZoomRecent = useCallback(() => {
    if (chartProvider === 'hookchart') { hookChartRef.current?.zoomToLatest(); return; }
    if (chartRef.current && klinesLengthRef.current > 0) {
      const total = klinesLengthRef.current;
      const visible = Math.min(80, total);
      chartRef.current.timeScale().setVisibleLogicalRange({
        from: total - visible,
        to: total + 4,
      });
    }
  }, [chartProvider]);

  // Ultra-fast live tick and series update:
  // 1. Candlestick series is updated directly on canvas with ZERO latency (bypassing React re-renders)
  // 2. React UI state updates (badges, price numbers) are throttled via RAF (~12fps max)
  // This completely eliminates CPU throttling and canvas stutter during high-frequency trade storms
  const handleLiveTick = useCallback(
    (candle: { time: number; open: number; high: number; low: number; close: number; volume?: number }, mode: 'ws' | 'rest') => {
      if (chartProvider !== 'hookchart' && !candleSeriesRef.current) return;
      const previousCandle = currentCandleRef.current;
      if (previousCandle && candle.time < previousCandle.time) return;
      if (previousCandle && candle.time > previousCandle.time &&
          previousCandle.time !== lastNotifiedClosedRef.current) {
        lastNotifiedClosedRef.current = previousCandle.time;
        // A new exchange candle is the conservative, provider-independent
        // signal that the prior candle closed; do NOT emit on each trade tick.
        onClosedCandleRef.current?.({
          ...previousCandle, volume: previousCandle.volume ?? 0,
        });
      }
      currentCandleRef.current = candle;
      if (chartProvider === 'hookchart') {
        hookTickRef.current = { ...candle, volume: candle.volume ?? 0 };
        if (!hookTickTimer.current) hookTickTimer.current = setTimeout(() => {
          hookTickTimer.current = null;
          const tick = hookTickRef.current;
          hookTickRef.current = null;
          if (tick) setEffectiveKlines(previous => mergeLiveCandle(previous, tick));
        }, 80);
      }

      try {
        if (klinesLengthRef.current > 0 && candleSeriesRef.current) {
          candleSeriesRef.current.update({
            time: candle.time as Time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          });
        }
      } catch {
        // Ignored
      }

      lastTickTimeRef.current = Date.now();
      const prevPrice = latestPriceRef.current;
      latestPriceRef.current = candle.close;

      const direction: 'up' | 'down' | 'neutral' =
        prevPrice !== null
          ? candle.close > prevPrice
            ? 'up'
            : candle.close < prevPrice
            ? 'down'
            : 'neutral'
          : 'neutral';

      pendingUiPriceRef.current = { price: candle.close, direction };

      const now = performance.now();
      if (now - lastUiUpdateTimestampRef.current >= 80) {
        lastUiUpdateTimestampRef.current = now;
        const update = pendingUiPriceRef.current;
        if (update) {
          setCurrentPrice(update.price);
          if (update.direction !== 'neutral') {
            setPriceDirection(update.direction);
          }
          onLivePriceUpdate?.(update.price);
        }
        setIsLiveConnected(true);
        setLiveMode(mode);
      } else if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          const uNow = performance.now();
          if (uNow - lastUiUpdateTimestampRef.current >= 80 && pendingUiPriceRef.current) {
            lastUiUpdateTimestampRef.current = uNow;
            const update = pendingUiPriceRef.current;
            setCurrentPrice(update.price);
            if (update.direction !== 'neutral') {
              setPriceDirection(update.direction);
            }
            onLivePriceUpdate?.(update.price);
            setIsLiveConnected(true);
            setLiveMode(mode);
          }
        });
      }
    },
    [onLivePriceUpdate, chartProvider]
  );

  // Initialize the selected renderer; both share the same exchange feeds.
  useEffect(() => {
    if (chartProvider === 'hookchart' || !chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#090d16' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#64748b',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1e293b',
        },
        horzLine: {
          color: '#64748b',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#1e293b',
        },
      },
      timeScale: {
        borderColor: 'rgba(51, 65, 85, 0.8)',
        timeVisible: true,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: true,
      },
      rightPriceScale: {
        borderColor: 'rgba(51, 65, 85, 0.8)',
        autoScale: true,
        scaleMargins: {
          top: 0.1,
          bottom: 0.1,
        },
        alignLabels: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
      kineticScroll: {
        touch: true,
        mouse: false,
      },
    });

    const removeTvLogo = () => {
      if (chartContainerRef.current) {
        const logo = chartContainerRef.current.querySelector('#tv-attr-logo');
        if (logo) {
          logo.remove();
        }
      }
    };
    removeTvLogo();
    const logoObserver = new MutationObserver(() => {
      removeTvLogo();
    });
    if (chartContainerRef.current) {
      logoObserver.observe(chartContainerRef.current, { childList: true, subtree: true });
    }

    const initialPrice = klines[klines.length - 1]?.close || formation?.levels.entryPrice || 1;
    const initialPriceFormat = getChartPriceFormat(initialPrice);

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
      priceFormat: initialPriceFormat,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    const handleCrosshairMove = (param: { point?: { x: number; y: number } }) => {
      if (!param.point || !onCrosshairPriceChangeRef.current) return;
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price !== null && Number.isFinite(price) && price > 0) {
        onCrosshairPriceChangeRef.current(price);
      }
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    let resizeTimer: any;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (chartRef.current && chartContainerRef.current) {
          const width = chartContainerRef.current.clientWidth;
          const height = chartContainerRef.current.clientHeight;
          if (width > 0 && height > 0) {
            chartRef.current.resize(width, height);
          }
        }
      }, 50);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      clearTimeout(resizeTimer);
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      resizeObserver.disconnect();
      logoObserver.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      priceLinesRef.current = [];
      hasInitiallyCenteredRef.current = false;
    };
  }, [chartProvider]);

  // Update data and price lines when klines change
  useEffect(() => {
    if (!candleSeriesRef.current || !chartRef.current || !effectiveKlines.length) return;

    const refPrice = effectiveKlines[effectiveKlines.length - 1]?.close || formation?.levels.entryPrice || 1;
    const priceFormatConfig = getChartPriceFormat(refPrice);
    candleSeriesRef.current.applyOptions({
      priceFormat: priceFormatConfig,
    });

    const chartData: CandlestickData<Time>[] = effectiveKlines.map((k) => ({
      time: k.time as Time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));

    const uniqueSortedData = chartData
      .filter((item, index, self) => index === self.findIndex((t) => t.time === item.time))
      .sort((a, b) => (a.time as number) - (b.time as number));

    candleSeriesRef.current.setData(uniqueSortedData);

    // Initial positioning: auto-focus to center of chart strictly ONCE upon entering page (or restore saved range)
    const totalBars = uniqueSortedData.length;
    if (savedChartParams?.visibleRange && totalBars > 0) {
      chartRef.current.timeScale().setVisibleLogicalRange(savedChartParams.visibleRange);
      hasInitiallyCenteredRef.current = true;
    } else if (totalBars > 0 && !hasInitiallyCenteredRef.current) {
      hasInitiallyCenteredRef.current = true;
      centerChartOnScreen();
      requestAnimationFrame(() => {
        centerChartOnScreen();
      });
    }

    // Remove existing price lines
    priceLinesRef.current.forEach((pl) => {
      try {
        candleSeriesRef.current?.removePriceLine(pl);
      } catch {
        // Ignored
      }
    });
    priceLinesRef.current = [];

    // Draw custom markers if passed from archive
    if (Array.isArray(customMarkers) && customMarkers.length > 0 && candleSeriesRef.current) {
      // Respect the shared TP/SL visibility state for saved/archive markers, too.
      (previewMarkers ? customMarkers : filterVisibleTradeMarkers(customMarkers, {
        entry: showEntryLevel, target: showTargetLevel, stop: showStopLevel,
      })).forEach((marker) => {
        let style = LineStyle.Solid;
        if (marker.lineStyle === 'dashed') style = LineStyle.Dashed;
        else if (marker.lineStyle === 'dotted') style = LineStyle.Dotted;

        const line = candleSeriesRef.current?.createPriceLine({
          price: marker.price,
          color: marker.color,
          lineWidth: (marker.lineWidth as any) || 2,
          lineStyle: style,
          axisLabelVisible: true,
          title: marker.label ? `${marker.label}` : '',
        });
        if (line) {
          priceLinesRef.current.push(line);
        }
      });
    } else if (formation && candleSeriesRef.current) {
      // Draw formation price levels if available
      if (showEntryLevel && formation.levels.entryPrice) {
        const line = candleSeriesRef.current.createPriceLine({
          price: formation.levels.entryPrice,
          color: '#38bdf8',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'Вхід',
        });
        priceLinesRef.current.push(line);
      }

      if (showTargetLevel && formation.levels.targetPrice) {
        const line = candleSeriesRef.current.createPriceLine({
          price: formation.levels.targetPrice,
          color: '#10b981',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'Ціль',
        });
        priceLinesRef.current.push(line);
      }

      if (showStopLevel && formation.levels.stopLossPrice) {
        const line = candleSeriesRef.current.createPriceLine({
          price: formation.levels.stopLossPrice,
          color: '#ef4444',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'Стоп',
        });
        priceLinesRef.current.push(line);
      }

      if (
        formation.levels.necklinePrice &&
        Math.abs(formation.levels.necklinePrice - formation.levels.entryPrice) > 0.0001 &&
        Math.abs(formation.levels.necklinePrice - formation.levels.targetPrice) > 0.0001
      ) {
        const line = candleSeriesRef.current.createPriceLine({
          price: formation.levels.necklinePrice,
          color: '#f59e0b',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: '',
        });
        priceLinesRef.current.push(line);
      }

      if (
        formation.levels.resistancePrice &&
        Math.abs(formation.levels.resistancePrice - formation.levels.entryPrice) > 0.0001 &&
        Math.abs(formation.levels.resistancePrice - formation.levels.targetPrice) > 0.0001 &&
        (!formation.levels.necklinePrice || Math.abs(formation.levels.resistancePrice - formation.levels.necklinePrice) > 0.0001)
      ) {
        const line = candleSeriesRef.current.createPriceLine({
          price: formation.levels.resistancePrice,
          color: '#f59e0b',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: '',
        });
        priceLinesRef.current.push(line);
      }

      if (
        formation.levels.supportPrice &&
        Math.abs(formation.levels.supportPrice - formation.levels.stopLossPrice) > 0.0001 &&
        Math.abs(formation.levels.supportPrice - formation.levels.entryPrice) > 0.0001
      ) {
        const line = candleSeriesRef.current.createPriceLine({
          price: formation.levels.supportPrice,
          color: '#a855f7',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: '',
        });
        priceLinesRef.current.push(line);
      }
    }
  }, [effectiveKlines, formation, customMarkers, showEntryLevel, showTargetLevel, showStopLevel, savedChartParams, chartProvider, previewMarkers]);

  const liveTickHandlerRef = useRef(handleLiveTick);
  liveTickHandlerRef.current = handleLiveTick;

  // Live mode only: ReplayChart is a separate historical renderer and NEVER
  // subscribes to these public-market streams. A browser tab shares one
  // exchange kline feed per instrument/TF and one trade feed per instrument.
  useEffect(() => {
    let disposed = false;
    let wsConnected = false;
    let lastExchangePriceAt = 0;
    let lastStreamTickReceivedAt = 0;
    let polling = false;
    let fallbackFailures = 0;
    let nextFallbackAt = Date.now() + 2000 + Math.floor(Math.random() * 1000);
    const cleanSymbol = normalizeExchangeSymbol(symbol);
    const intervalMs = ({
      '1m': 60_000, '5m': 300_000, '15m': 900_000,
      '1h': 3600_000, '4h': 14400_000, '1d': 86400_000,
    } as Record<string, number>)[timeframe] || 3600_000;

    const stopKlines = subscribeSharedKlines(
      { exchange, marketType, symbol: cleanSymbol, timeframe },
      {
        onStatus: connected => {
          if (disposed) return;
          wsConnected = connected;
          setIsLiveConnected(connected);
          if (connected) { setLiveMode('ws'); fallbackFailures = 0; }
        },
        onCandle: candle => {
          if (disposed) return;
          lastStreamTickReceivedAt = Date.now();
          const eventAt = Number(candle.eventTime) || Date.now();
          const current = currentCandleRef.current;
          // Separate trade and kline sockets are not guaranteed to deliver in
          // global order. A slightly older kline still supplies authoritative
          // CUMULATIVE OHLCV, but must not undo a more recent trade price.
          const corrected = current && current.time === candle.time &&
            eventAt < lastExchangePriceAt
            ? { ...candle, close: current.close,
                high: Math.max(candle.high, current.high, current.close),
                low: Math.min(candle.low, current.low, current.close) }
            : candle;
          if (!current || candle.time > current.time) lastExchangePriceAt = eventAt;
          else lastExchangePriceAt = Math.max(lastExchangePriceAt, eventAt);
          liveTickHandlerRef.current(corrected, 'ws');
        },
      },
    );

    const stopTrades = subscribeMarketTrades(
      { exchange, marketType, symbol: cleanSymbol },
      {
        // REST seed is for analytics/density history, never a live candle tick.
        liveOnly: true,
        wantsPrints: () => false,
        onPrints: () => {},
        onTrade: trade => {
          if (disposed || !Number.isFinite(trade.p) || trade.p <= 0) return;
          const current = currentCandleRef.current;
          if (!current || trade.t <= lastExchangePriceAt ||
              trade.t < current.time * 1000 ||
              trade.t >= current.time * 1000 + intervalMs) return;
          lastExchangePriceAt = trade.t;
          lastStreamTickReceivedAt = Date.now();
          liveTickHandlerRef.current({
            ...current, close: trade.p,
            high: Math.max(current.high, trade.p),
            low: Math.min(current.low, trade.p),
            // The kline stream is the authoritative source of candle volume.
            // Adding aggregate trades here double-counted overlapping ticks.
            volume: current.volume,
          }, 'ws');
        },
      },
    );

    const runFastPoll = async () => {
      if (disposed || polling || document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (wsConnected && now - lastTickTimeRef.current < 5000) return;
      if (now < nextFallbackAt) return;
      // Exponential backoff + jitter prevents reconnect storms hitting VPS.
      const wait = wsConnected ? 30_000 :
        Math.min(20_000, 4000 * 2 ** Math.min(4, fallbackFailures));
      nextFallbackAt = now + wait + Math.floor(Math.random() * 1500);
      polling = true;
      const requestStartedAt = Date.now();
      try {
        const latest = await fetchSharedLiveFallbackKline(exchange, marketType, cleanSymbol, timeframe);
        if (disposed) return;
        if (!latest) { fallbackFailures++; return; }
        if (!shouldApplyLiveFallbackKline(latest, currentCandleRef.current,
          requestStartedAt, lastStreamTickReceivedAt, wsConnected)) return;
        // Even a successful REST fallback must back off while WS stays down;
        // otherwise an exchange outage creates a permanent 4s VPS poll storm.
        if (!wsConnected) fallbackFailures++;
        else fallbackFailures = 0;
        liveTickHandlerRef.current(latest, 'rest');
      } catch {
        fallbackFailures++;
      } finally {
        polling = false;
      }
    };
    const pollInterval = setInterval(() => void runFastPoll(), 2000);
    return () => {
      disposed = true;
      clearInterval(pollInterval);
      stopTrades();
      stopKlines();
    };
  }, [symbol, timeframe, exchange, marketType]);

  // One control always changes all three plotted levels together, regardless
  // of chart provider, page or fullscreen state.
  const combinedTradeLevels = {
    visible: showEntryLevel && showTargetLevel && showStopLevel,
    available: hasTradeLevels,
    onToggle: () => applyTradeLevels(toggleCombinedTradeLevels({
      entry: showEntryLevel, target: showTargetLevel, stop: showStopLevel,
    })),
  };

  const chartActions = (onAddToArchive || onOpenFullscreen) ? (
    <>
      {onAddToArchive && (
        <button
          type="button"
          onClick={onAddToArchive}
          disabled={isSavingArchive}
          className="chart-archive-action p-1 sm:p-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/40 text-purple-300 transition-colors disabled:opacity-50 cursor-pointer shrink-0"
          title={isArchived ? 'Формацію збережено в архіві' : 'Додати монету та формацію в архів'}
          aria-label={isArchived ? 'Формацію збережено в архіві' : 'Додати монету та формацію в архів'}
        >
          {isArchived ? <CheckCircle2 className="w-3.5 h-3.5" /> : <FormationArchiveIcon className={`w-3.5 h-3.5 ${isSavingArchive ? 'animate-pulse' : ''}`} />}
        </button>
      )}
      {onOpenFullscreen && (
        <button
          type="button"
          onClick={onOpenFullscreen}
          className="chart-fullscreen-action p-1 sm:p-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 transition-colors cursor-pointer shrink-0"
          title="Відкрити повний графік"
          aria-label="Відкрити повний графік"
        >
          <Expand className="w-3.5 h-3.5" />
        </button>
      )}
    </>
  ) : null;

  return (
    <div className={`relative w-full rounded-2xl overflow-hidden border border-slate-800 bg-slate-950 shadow-xl flex flex-col ${fullHeight ? 'h-full flex-1 min-h-0' : ''}`}>
      {/* Top Header Bar */}
      {showNavigationControls && (!hideSymbolAndPrice || !hideHeaderLiveIndicator || (!hideHeaderFormationBadge && !!formation)) && (
        <div className="flex flex-wrap items-center justify-between gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 bg-slate-900/95 border-b border-slate-800 text-xs z-10 shrink-0">
          {/* Left: Symbol, Live Price, Badges */}
          <div className="flex items-center flex-wrap gap-1.5 sm:gap-2">
            {!hideSymbolAndPrice && (
              <>
                <span className="font-bold text-slate-100 font-mono text-xs sm:text-sm tracking-wide">{symbol}</span>

                {/* Live Price Tag */}
                {currentPrice !== null && (
                  <div
                    className={`flex items-center gap-1 font-mono font-bold px-1.5 sm:px-2 py-0.5 rounded-lg border text-[11px] sm:text-xs transition-all duration-300 ${
                      tickAnimation
                        ? priceDirection === 'up'
                          ? 'bg-emerald-500/30 text-emerald-300 border-emerald-500 scale-105 shadow-sm shadow-emerald-500/20'
                          : 'bg-rose-500/30 text-rose-300 border-rose-500 scale-105 shadow-sm shadow-rose-500/20'
                        : priceDirection === 'up'
                        ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/60'
                        : priceDirection === 'down'
                        ? 'bg-rose-950/60 text-rose-400 border-rose-800/60'
                        : 'bg-slate-800 text-slate-200 border-slate-700'
                    }`}
                  >
                    <span>${formatCryptoPrice(currentPrice)}</span>
                    {priceDirection === 'up' ? (
                      <span className="text-[9px] sm:text-[10px] text-emerald-400 font-extrabold">▲</span>
                    ) : priceDirection === 'down' ? (
                      <span className="text-[9px] sm:text-[10px] text-rose-400 font-extrabold">▼</span>
                    ) : null}
                  </div>
                )}
              </>
            )}

            {/* Live Stream Status Indicator */}
            {!hideHeaderLiveIndicator && (
              <div
                className={`flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 rounded-full border text-[10px] sm:text-[11px] font-mono font-medium ${
                  isLiveConnected
                    ? 'bg-emerald-950/70 border-emerald-700/60 text-emerald-300'
                    : 'bg-slate-800/80 border-slate-700 text-slate-400'
                }`}
                title={`Оновлення в реальному часі (${liveMode.toUpperCase()})`}
              >
                <span className="relative flex h-2 w-2">
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                      isLiveConnected ? 'bg-emerald-400' : 'bg-slate-400'
                    }`}
                  ></span>
                  <span
                    className={`relative inline-flex rounded-full h-2 w-2 ${
                      isLiveConnected ? 'bg-emerald-500' : 'bg-slate-500'
                    }`}
                  ></span>
                </span>
                <span className="font-bold tracking-wider">
                  {liveMode === 'ws' ? '⚡' : '●'}
                </span>
              </div>
            )}

            {!hideHeaderFormationBadge && formation && (
              <span
                className={`px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-medium truncate max-w-[130px] sm:max-w-none ${
                  formation.bias === 'bullish'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : formation.bias === 'bearish'
                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                }`}
                title={formation.name}
              >
                {formation.name}
              </span>
            )}
          </div>
        </div>
      )}

      {chartProvider !== 'hookchart' && (onTimeframeChange || formation || Boolean(customMarkers?.length)) && (
        <div className="chart-above-controls flex items-center justify-between gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 bg-slate-900/90 border-b border-slate-800/80 overflow-x-auto no-scrollbar flex-nowrap w-full">
          <div className="flex items-center gap-1 sm:gap-1.5 flex-nowrap shrink-0">
            {/* Timeframe selector directly above the chart */}
            {onTimeframeChange && <div className="flex items-center bg-slate-950 p-0.5 rounded-lg border border-slate-800 text-xs font-mono shrink-0">
              {(['1m', '5m', '15m', '1h', '4h', '1d'] as Timeframe[]).map((option) => (
                <button
                  key={option}
                  onClick={() => onTimeframeChange(option)}
                  className={`px-1.5 sm:px-2 py-0.5 sm:py-1 rounded transition-colors cursor-pointer text-[11px] sm:text-xs shrink-0 ${
                    timeframe === option ? 'bg-cyan-600 text-white font-bold shadow-sm' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>}

            {!previewMarkers && (formation || customMarkers?.length) ? (
              <button
                type="button"
                onClick={combinedTradeLevels.onToggle}
                disabled={!combinedTradeLevels.available}
                aria-pressed={combinedTradeLevels.visible}
                aria-label={combinedTradeLevels.available ? (combinedTradeLevels.visible
                  ? 'Приховати рівні Вхід, TP і SL' : 'Показати рівні Вхід, TP і SL') : 'TP/SL: немає трьох розрахованих рівнів'}
                title={combinedTradeLevels.available ? 'Увімкнути або вимкнути всі три рівні: Вхід, TP, SL' : 'Потрібні ціни входу, цілі та стопу'}
                className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors ${combinedTradeLevels.visible
                  ? 'border-cyan-500/60 bg-cyan-500/20 text-cyan-200'
                  : 'border-slate-700 bg-slate-800 text-slate-300'} disabled:cursor-not-allowed disabled:opacity-45`}
              >
                <Target className="h-3.5 w-3.5" aria-hidden="true" />
                <span>TP/SL</span>
              </button>
            ) : null}
          </div>

          {/* Right: View Controls */}
          <div className="flex items-center gap-1 sm:gap-1.5 text-slate-300 text-[10px] sm:text-[11px] flex-nowrap shrink-0 ml-auto">
            {/* TradingView-only history controls. Hookchart has its own navigation controls. */}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={handleZoomRecent}
                  className="flex items-center gap-1 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors border border-slate-700 text-[10px] sm:text-[11px] cursor-pointer active:scale-95 shrink-0 whitespace-nowrap"
                  title="Наблизити до останніх свічок"
                >
                  <ZoomIn className="w-3 h-3 text-cyan-400" />
                  <span className="hidden md:inline">Останні свічки</span>
                </button>

                <button
                  onClick={handleFitAll}
                  className="flex items-center gap-1 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors border border-slate-700 text-[10px] sm:text-[11px] cursor-pointer active:scale-95 shrink-0 whitespace-nowrap"
                  title="Вписати всю завантажену історію свічок"
                >
                  <Maximize2 className="w-3 h-3 text-cyan-400" />
                  <span className="hidden md:inline">Вся історія</span>
                  <span className="font-mono text-[9px] sm:text-[10px] text-slate-400">({klines.length})</span>
                </button>
              </div>

            <div className="flex items-center gap-1 shrink-0">
              {chartActions}
            </div>
          </div>
        </div>
      )}

      {/* Chart Canvas */}
      <div
        className={`relative w-full overflow-hidden ${fullHeight ? "flex-1 min-h-0" : "h-[520px] xs:h-[540px] sm:h-[540px] md:h-[350px] lg:h-[390px] xl:h-[430px]"}`}
        style={{ contain: 'content' }}
      >
        {/* TradingView Chart Container */}
        {chartProvider === 'hookchart' ? <HookChart ref={hookChartRef} klines={effectiveKlines}
          symbol={symbol} timeframe={timeframe} exchange={exchange} marketType={marketType}
          terminalMode={terminalMode} terminalAutoScale={terminalAutoScale} terminalInitialView={terminalInitialView} visualContext={visualContext} terminalToolbarVisibility={terminalToolbarVisibility} focusFormation={formation}
          markers={hookMarkers} expandPriceScaleToMarkers={previewMarkers} savedChartParams={savedChartParams} onTimeframeChange={onTimeframeChange}
          onCrosshairPriceChange={onCrosshairPriceChange}
          tradeLevelToggle={previewMarkers ? undefined : combinedTradeLevels}
          toolbarActions={hookchartToolbarActions} toolbarOverlays={hookchartToolbarOverlays}
          chartActions={showNavigationControls ? chartActions : null} /> : <div
          ref={chartContainerRef}
          className="w-full h-full relative"
          data-chart-provider="tradingview"
          style={{ willChange: 'transform', transform: 'translateZ(0)' }}
        />}

        {/* Right-bottom countdown to candle close */}
        {chartProvider !== 'hookchart' && <div className="absolute right-2.5 sm:right-3 bottom-2.5 sm:bottom-3 z-30 flex items-center gap-1.5 sm:gap-2 select-none pointer-events-auto">
          {/* Time to Bar Close Countdown with Ticking */}
          <div
            className={`flex items-center gap-1.5 px-1 py-0.5 text-xs font-mono font-bold select-none transition-all duration-300 ${
              barCountdown.isUrgent
                ? `text-rose-300 ${
                    tickPulse ? 'scale-105 opacity-100 text-rose-200' : 'scale-100 opacity-90'
                  }`
                : 'text-slate-200 hover:text-white'
            }`}
            title={`Час до закриття поточної ${timeframe} свічки: ${barCountdown.formatted}`}
          >
            <Clock
              className={`w-3.5 h-3.5 ${
                barCountdown.isUrgent
                  ? 'text-rose-400 animate-spin'
                  : 'text-cyan-400'
              }`}
              style={{ animationDuration: barCountdown.isUrgent ? '3s' : '10s' }}
            />

            <span
              className={`tracking-wider ${
                barCountdown.isUrgent
                  ? 'text-rose-300 font-extrabold text-[12px]'
                  : 'text-white'
              }`}
            >
              {barCountdown.formatted}
            </span>

            {barCountdown.isUrgent && (
              <span className="relative flex h-2 w-2 ml-0.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
              </span>
            )}
          </div>
        </div>}
      </div>
    </div>
  );
};

