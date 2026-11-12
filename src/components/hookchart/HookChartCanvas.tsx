import { ReplaySpeedPicker } from '../replay/ReplaySpeedPicker';
import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Crosshair, Minus, MoveUpRight, Square, Type, Ruler, Bell, BarChart3, Layers, Settings, Target, Trash2, X } from 'lucide-react';
import type { ChartMarkerInfo, ChartRestoreParams, DetectedFormation, ExchangeId, HookChartPreferences, Kline, MarketType, Timeframe } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { useAlerts } from '../../context/AlertsContext';
import { useTelegram } from '../../context/TelegramContext';
import { alertConditionForPrice, chartTelegramAlerts, telegramIdFromChartMarker } from '../../utils/hookChartPriceAlerts';
import { useLanguage } from '../../context/LanguageContext';
import { resolveHookChartLanguage } from '../../locales/hookchartLanguage';
import { toHookCandles } from '../../utils/hookchartData';
import { resolveTimeZone } from '../../utils/tradingSessions';
import { fetchHistoricalReplayCandles } from '../../utils/replayService';
import { normalizeExchangeSymbol } from '../../utils/marketSymbols';
import { fetchDirectKlines } from '../../utils/directExchangeClient';
import { fetchSharedAnalysisKlines } from '../../utils/sharedAnalysisKlines';
import { candlesBeforeHistoryEnd, clampHookChartHistory, extendHookChartHistory, scopedHookChartHistoryRows, type ScopedHookChartHistory } from '../../utils/hookChartHistory';
import { createChartCrosshairStore } from './crosshairState';
import { Chart, ChartTimeAxis, IndicatorDock, buildStructuralChannel, type Alert, type Candle, type Drawing, type HookChartHandle, type Viewport } from './engine';
import { INDICATOR_META, type IndicatorId, type OIPoint } from './indicatorEngine';
import { captureVisualProfile, getVisualProfile, makeVisualProfileKey, patchVisualProfile, visualContextForTerminalWidth, visualDeviceForWidth, type VisualContextId, type VisualProfileKey } from './visualProfiles';
import { hookChartPlotWidth } from './priceScale';
import { FibIcon, IndicatorIcon, OverlayIcon } from './ToolbarIcons';
import { HookChartTimeframePicker } from './HookChartTimeframePicker';
import { DEFAULT_HOOKCHART_HOTKEYS, OriginalHookChartSettings, hotkeyMatches, normalizeOriginalHookChartPreferences } from './OriginalHookChartSettings';
import { evaluateStrategy, strategyPreset, strategyPreferencePatch } from './strategyEngine';
import { atr, deriveAutoLevels, formatUsd, normalizeDensityDistance, type LevelTf } from './marketAnalytics';
import { useOriginalHookChartLiveFeed } from './useOriginalHookChartLiveFeed';
import { visibleChartDensities } from './reactionPotential';
import { btcBenchmarkSymbol, calculateBtcCorrelation } from '../../utils/chartCorrelation';
import type { HookTimeMarker } from './timeMarkers';
import './hookchart.css';
import './integration.css';

/** Local visibility state belonging to one chart block in Terminal only.
 * Opening these panels does not write shared HookChart account settings.
 */
export interface TerminalToolbarVisibility {
  extraToolsOpen: boolean;
  drawingToolsOpen: boolean;
  onExtraToolsOpenChange: (open: boolean) => void;
  onDrawingToolsOpenChange: (open: boolean) => void;
}

export interface HookChartCanvasProps {
  externalData?: {
    onNeedHistory: (timestamp: number) => Promise<boolean>;
    timeframes: string[]; onTimeframeChange: (timeframe: string) => void;
    timeMarkers: HookTimeMarker[];
    onAppearanceChange?: (changes: { upColor?: string; downColor?: string; volume?: boolean }) => void;
    appearance: { upColor: string; downColor: string; gridColor: string; background: string; volume: boolean };
  };
  klines: Kline[];
  symbol: string;
  timeframe: string;
  exchange: ExchangeId;
  marketType: MarketType;
  markers?: ChartMarkerInfo[];
  /** Include provisional targets and stops in the auto price scale when previewing. */
  expandPriceScaleToMarkers?: boolean;
  savedChartParams?: ChartRestoreParams;
  replay?: boolean;
  focusTrigger?: number;
  terminalMode?: boolean;
  /** Terminal-only global auto-scale; reuses live candles and the current canvas. */
  terminalAutoScale?: boolean;
  /** Live placement; Replay ignores all user visual presets. */
  visualContext?: VisualContextId;
  terminalToolbarVisibility?: TerminalToolbarVisibility;
  focusFormation?: DetectedFormation | null;
  onTimeframeChange?: (timeframe: Timeframe) => void;
  /** Optional vertical crosshair price from the main chart, for the price-alert input. */
  onCrosshairPriceChange?: (price: number) => void;
  /** Replay-only protection while historical candles are loading. */
  timeframeDisabled?: boolean;
  replayPlaybackSpeed?: number;
  onReplayPlaybackSpeedChange?: (speed: number) => void;
  onExchangeChange?: (exchange: ExchangeId) => void;
  chartActions?: React.ReactNode;
  toolbarActions?: React.ReactNode;
  toolbarOverlays?: React.ReactNode;
  tradeLevelToggle?: { visible: boolean; available?: boolean; onToggle: () => void };
  footerActions?: React.ReactNode;
}

const EMPTY_OI = { binance: [] as OIPoint[], bybit: [] as OIPoint[] };
const DEFAULT_VIEWPORT: Viewport = { barWidth: 9, rightOffset: 0, autoY: true, manualCenter: null, manualRange: null, fitAll: false };
const TOOLS = [
  ['cursor', 'Курсор', Crosshair], ['level', 'Горизонтальний рівень', Minus], ['trend', 'Лінія тренду', MoveUpRight],
  ['rect', 'Прямокутник', Square], ['fib', 'Рівні Фібоначчі', FibIcon], ['profile', 'Профіль обсягу', BarChart3],
  ['text', 'Текст', Type], ['ruler', 'Вимірювання', Ruler], ['alert', 'Сигнальний рівень', Bell],
] as const;
const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
const TF_MS: Record<string, number> = { '1s': 1000, '5s': 5000, '15s': 15000, '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const LEVEL_TFS = new Set<LevelTf>(['5m', '15m', '1h', '4h', '1d']);

function aggregateCandles(source: Candle[], sourceTf: string, targetTf: string): Candle[] {
  const sourceMs = TF_MS[sourceTf] || 0;
  const targetMs = TF_MS[targetTf] || 0;
  if (!source.length || !sourceMs || !targetMs || targetMs < sourceMs) return targetTf === sourceTf ? source : [];
  if (targetMs === sourceMs) return source;
  const out: Candle[] = [];
  let current: Candle | null = null;
  let bucket = -1;
  for (const candle of source) {
    const nextBucket = Math.floor(candle.t / targetMs) * targetMs;
    if (!current || nextBucket !== bucket) {
      if (current) out.push(current);
      bucket = nextBucket;
      current = { ...candle, t: nextBucket };
    } else {
      current.h = Math.max(current.h, candle.h);
      current.l = Math.min(current.l, candle.l);
      current.c = candle.c;
      current.v += candle.v || 0;
      current.n += candle.n || 0;
      current.tb = (current.tb || 0) + (candle.tb || 0);
    }
  }
  if (current) out.push(current);
  return out;
}
const OVERLAYS = [
  ['sr', 'Підтримка та опір'], ['prevDay', 'Хай / лой минулого дня'], ['dayOpen', 'Відкриття дня'],
  ['vwap', 'VWAP'], ['localHL', 'Локальні екстремуми'], ['roundLevels', 'Круглі рівні'], ['poc', 'POC'],
  ['channel', 'Канал'], ['stops', 'Зони стопів'],
] as const;

function enabledIndicators(preferences?: HookChartPreferences, replay = false, market: MarketType = 'futures'): IndicatorId[] {
  return (preferences?.indicators || []).filter((id): id is IndicatorId => INDICATOR_META.some(meta => meta.id === id)
    && (id !== 'oi' || (!replay && market === 'futures')));
}

const HookChartCanvas = forwardRef<HookChartHandle, HookChartCanvasProps>(function HookChartCanvas({
  externalData, klines, symbol, timeframe, exchange, marketType, markers = [], expandPriceScaleToMarkers = false, savedChartParams, replay = false, focusTrigger, terminalMode = false, terminalAutoScale = false, visualContext, terminalToolbarVisibility, focusFormation, onTimeframeChange, onCrosshairPriceChange, timeframeDisabled = false, replayPlaybackSpeed, onReplayPlaybackSpeedChange, chartActions, toolbarActions, toolbarOverlays, tradeLevelToggle, footerActions,
}, forwardedRef) {
  const { user, profile, updateProfileData } = useAuth();
  const { alerts: priceAlerts, addAlert, deleteAlert } = useAlerts();
  const { status: telegramStatus } = useTelegram();
  const { language: siteLanguage } = useLanguage();
  const preferences = profile?.uid === user?.uid ? profile?.hookChartPreferences : undefined;
  const scope = `${replay ? 'replay' : 'live'}:${exchange}:${marketType}:${symbol}`;
  const sharedScope = `shared:${symbol}`;
  const [settings, setSettings] = useState<HookChartPreferences>(() => normalizeOriginalHookChartPreferences(preferences));
  const chartLanguage = resolveHookChartLanguage(settings, siteLanguage);
  const [drawings, setDrawingsState] = useState<Drawing[]>(() => replay ? [] :
    (preferences?.sharedDrawings !== false ? preferences?.drawings?.[sharedScope] : undefined) || preferences?.drawings?.[scope] || []);
  const [alerts, setAlertsState] = useState<Alert[]>(() => replay ? [] :
    (preferences?.sharedDrawings !== false ? preferences?.alerts?.[sharedScope] : undefined) || preferences?.alerts?.[scope] || []);
  const drawingsRef = useRef(drawings);
  const alertsRef = useRef(alerts);
  const creatingPriceAlert = useRef(false);
  const [alertNotice, setAlertNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [selectedPriceMarker, setSelectedPriceMarker] = useState<string | null>(null);
  const [deletingPriceMarker, setDeletingPriceMarker] = useState(false);
  const tempRulerRef = useRef<{ code: string; tool: string } | null>(null);
  const [tool, setTool] = useState('cursor');
  // Replay-only UI state must not alter live HookChart account preferences.
  const [replayToolsOpen, setReplayToolsOpen] = useState(false);
  const [replayDrawingToolbarOpen, setReplayDrawingToolbarOpen] = useState(false);
  const [replayOverlays, setReplayOverlays] = useState<string[]>([]);
  const [replayIndicators, setReplayIndicators] = useState<IndicatorId[]>([]);
  const [textLabel, setTextLabel] = useState('Нотатка');
  const [panel, setPanel] = useState<'indicators' | 'settings' | null>(null);
  const closeSettings = useCallback(() => setPanel(null), []);
  const [densityQuickOpen, setDensityQuickOpen] = useState(false);
  const [densityPopupLeft, setDensityPopupLeft] = useState(8);
  const [densityThresholdDraft, setDensityThresholdDraft] = useState<string | null>(null);
  const [densityDistanceDraft, setDensityDistanceDraft] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const historyScope = [exchange, marketType, normalizeExchangeSymbol(symbol), timeframe].join(':');
  const crosshair = useMemo(() => createChartCrosshairStore(), [historyScope]);
  const [extraHistory, setExtraHistory] = useState<ScopedHookChartHistory>(() => ({ scope: historyScope, rows: [] }));
  const extraHistoryRef = useRef(extraHistory);
  extraHistoryRef.current = extraHistory;
  const extraHistoryRows = scopedHookChartHistoryRows(extraHistory, historyScope);
  const [historyState, setHistoryState] = useState<{ scope: string; status: 'idle' | 'loading' | 'limited' | 'error' }>({ scope: historyScope, status: 'idle' });
  const historyStatus = historyState.scope === historyScope ? historyState.status : 'idle';
  const [historyRetry, setHistoryRetry] = useState(0);
  const [remoteSeries, setRemoteSeries] = useState<Record<string, Candle[]>>({});
  const [oi, setOi] = useState(EMPTY_OI);
  const [oiError, setOiError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [profileSyncVersion, refreshProfileSettings] = useState(0);
  const engineRef = useRef<HookChartHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [visualDevice, setVisualDevice] = useState(() =>
    visualDeviceForWidth(typeof window === 'undefined' ? 1280 : window.innerWidth));
  const [terminalVisualContext, setTerminalVisualContext] = useState<VisualContextId>('terminalMedium');
  useEffect(() => {
    if (replay) return;
    const updateDevice = () => setVisualDevice(visualDeviceForWidth(window.innerWidth));
    updateDevice();
    window.addEventListener('resize', updateDevice);
    return () => window.removeEventListener('resize', updateDevice);
  }, [replay]);
  useEffect(() => {
    if (!terminalMode || replay || !rootRef.current || typeof ResizeObserver === 'undefined') return;
    const root = rootRef.current;
    const update = () => setTerminalVisualContext(visualContextForTerminalWidth(root.getBoundingClientRect().width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, [terminalMode, replay]);
  const activeVisualContext = terminalMode ? terminalVisualContext : (visualContext || 'screenerQuick');
  const activeVisualKey = makeVisualProfileKey(activeVisualContext, visualDevice);
  // No saved profile means legacy HookChart defaults stay unchanged.
  const activeVisualProfile = replay || !settings.visualProfiles?.[activeVisualKey]
    ? undefined : getVisualProfile(settings, activeVisualContext, visualDevice);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const extraToolsRef = useRef<HTMLDivElement | null>(null);
  const statsBarRef = useRef<HTMLDivElement | null>(null);
  const integratedToolbar = terminalMode && !!toolbarActions;
  // A Terminal chart's panel is controlled by its own widget, never by
  // the account-wide preference. Other chart pages keep their old behavior.
  const terminalExtraToolsOpen = integratedToolbar && terminalToolbarVisibility
    ? terminalToolbarVisibility.extraToolsOpen
    : settings.terminalExtraToolsOpen === true;
  const scrollExtraTools = (direction: -1 | 1) => {
    const strip = extraToolsRef.current;
    if (!strip) return;
    strip.scrollBy({ left: direction * Math.max(120, Math.round(strip.clientWidth * 0.75)), behavior: 'smooth' });
  };
  // The optional strip is dynamically mounted. Attach the wheel handler to the
  // stable toolbar instead: scrolling also works when the pointer is on its
  // expand chevron, and the browser cannot lose the listener after remounts.
  const onExtraToolsWheel = useCallback((event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    const strip = extraToolsRef.current;
    const toolbar = toolbarRef.current;
    const target = event.target;
    if (!strip || !toolbar || !(target instanceof Element) || !toolbar.contains(target)) return;
    // Timeframes and fixed controls are interactive, never scroll those away.
    if (target.closest('.hookchart-timeframes, .toolbarRight, .hookchart-toolbar-actions')) return;
    const maxScroll = strip.scrollWidth - strip.clientWidth;
    if (maxScroll <= 1) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
    const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
    if (!delta) return;
    const next = Math.max(0, Math.min(maxScroll, strip.scrollLeft + delta));
    if (Math.abs(next - strip.scrollLeft) >= 0.5) {
      event.preventDefault();
      event.stopPropagation();
      strip.scrollLeft = next;
    }
  }, []);
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    toolbar.addEventListener('wheel', onExtraToolsWheel, { passive: false, capture: true });
    return () => toolbar.removeEventListener('wheel', onExtraToolsWheel, true);
  }, [onExtraToolsWheel]);
  const [controlsContainer, setControlsContainer] = useState<HTMLDivElement | null>(null);
  const [countdownContainer, setCountdownContainer] = useState<HTMLDivElement | null>(null);
  const saveRef = useRef(updateProfileData);
  saveRef.current = updateProfileData;
  const pending = useRef<HookChartPreferences | null>(null);
  // A deferred write belongs to the account which made the edit. Never
  // allow a pending delta from one account to be written to another.
  const pendingOwnerUid = useRef<string | null>(null);
  const activeUid = useRef<string | null>(user?.uid ?? null);
  activeUid.current = user?.uid ?? null;
  const lastLoadedUid = useRef<string | null>(user?.uid ?? null);
  const savingByUid = useRef(new Map<string, number>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    const scrollers = [
      integratedToolbar ? toolbarRef.current?.querySelector<HTMLDivElement>('.hookchart-terminal-scroll') : null,
      terminalMode ? statsBarRef.current : null,
    ]
      .filter((element): element is HTMLDivElement => !!element);
    const cleanup = scrollers.map(element => {
      const onWheel = (event: WheelEvent) => {
        if (event.ctrlKey || event.metaKey || element.scrollWidth <= element.clientWidth) return;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
        const previous = element.scrollLeft;
        element.scrollLeft += delta * unit;
        if (element.scrollLeft !== previous) event.preventDefault();
      };
      element.addEventListener('wheel', onWheel, { passive:false });
      return () => element.removeEventListener('wheel', onWheel);
    });
    return () => cleanup.forEach(dispose => dispose());
  }, [terminalMode, integratedToolbar, terminalExtraToolsOpen, settings.showTopToolbarIcons, settings.showMarketStatsBar]);
  const indicators = replay ? replayIndicators : enabledIndicators(settings, !!externalData, marketType);
  const timezone = settings.timezone || resolveTimeZone(profile?.timeZone);
  // Replay must remain causal; live chart history can be extended and capped independently.
  const maxChartCandles = settings.maxChartCandles === undefined ? undefined : clampHookChartHistory(settings.maxChartCandles);
  const candles = useMemo(() => {
    const rows = toHookCandles(replay ? klines : [...extraHistoryRows, ...klines]);
    return !replay && maxChartCandles ? rows.slice(-maxChartCandles) : rows;
  }, [klines, extraHistoryRows, replay, maxChartCandles]);
  const historyRequestKey = useRef('');
  useEffect(() => {
    // The renderer always shows the most recent candles first; the full
    // configured history is fetched separately in pages of up to 1000.
    // Use the normalized symbol (BTC/USDT must work just like BTCUSDT).
    const normalizedSymbol = normalizeExchangeSymbol(symbol);
    if (replay || externalData || !maxChartCandles || !klines.length ||
        !/^[A-Z0-9]{3,30}$/i.test(normalizedSymbol)) return;
    const key = [exchange, marketType, normalizedSymbol, timeframe, maxChartCandles, historyRetry].join(':');
    if (historyRequestKey.current === key) return;
    historyRequestKey.current = key;

    const controller = new AbortController();
    const source = [...scopedHookChartHistoryRows(extraHistoryRef.current, historyScope), ...klines].sort((a, b) => a.time - b.time);
    if (source.length >= maxChartCandles) {
      setHistoryState({ scope: historyScope, status: 'idle' });
      return;
    }
    const firstCurrentTime = Math.min(...klines.map(row => row.time));
    const acceptPage = (rows: Kline[]) => {
      if (controller.signal.aborted) return;
      setExtraHistory({ scope: historyScope, rows: rows.filter(row => row.time < firstCurrentTime) });
    };
    setHistoryState({ scope: historyScope, status: 'loading' });

    const fetchOlder = async (endTime: number, limit: number): Promise<Kline[]> => {
      const q = new URLSearchParams({
        exchange, market: marketType, symbol: normalizedSymbol,
        timeframe, limit: String(limit), endTime: String(endTime),
      });
      const response = await fetch('/api/klines?' + q, { signal: controller.signal });
      if (!response.ok) throw new Error('Історія свічок недоступна');
      const json = await response.json();
      if (!json.success || !Array.isArray(json.data)) throw new Error('Некоректні історичні свічки');
      const fromServer = candlesBeforeHistoryEnd(json.data as Kline[], endTime);
      if (fromServer.length) return fromServer;
      // An upstream mirror may return an empty page or ignore the endTime.
      // Try the direct public exchange API before claiming no older history.
      const direct = await fetchDirectKlines(exchange, marketType, normalizedSymbol, timeframe as Timeframe, limit, undefined, endTime);
      return candlesBeforeHistoryEnd(direct, endTime);
    };

    void extendHookChartHistory(source, maxChartCandles, fetchOlder, acceptPage, controller.signal)
      .then(rows => {
        if (controller.signal.aborted) return;
        acceptPage(rows);
        setHistoryState({ scope: historyScope, status: rows.length >= maxChartCandles ? 'idle' : 'limited' });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        console.warn('[HookChart] Could not load older candles', error);
        // Successful earlier pages remain on the chart; retry from their oldest bar.
        setHistoryState({ scope: historyScope, status: 'error' });
      });
    return () => controller.abort();
  }, [replay, !!externalData, historyScope, exchange, marketType, symbol, timeframe, maxChartCandles, klines.length > 0, historyRetry]);

  const liveFeed = useOriginalHookChartLiveFeed({ exchange, marketType, symbol, settings, candles, replay });
  const potentialDensityCount = liveFeed.densities.filter(density => density.reactionTier === 'potential').length;
  // Only filter the chart. Strategy evaluation and density lists retain the full live book.
  const chartDensities = visibleChartDensities(liveFeed.densities, settings.densityMode, settings.densityAutoDisplay);
  const activeStrategy = useMemo(() => strategyPreset(settings.strategyId || ''), [settings.strategyId]);
  const analysisTfs = useMemo(() =>
    Array.from(new Set<string>([timeframe, ...(settings.levelIntervals || []), ...(settings.trendIntervals || []), ...(activeStrategy?.requiredTfs || [])])),
    [timeframe, (settings.levelIntervals || []).join(','), (settings.trendIntervals || []).join(','), activeStrategy?.id]);
  const analysisTfKey = analysisTfs.join(',');

  useEffect(() => {
    const exchangeSymbol = /^[A-Z0-9]+$/i.test(symbol);
    if (replay || externalData || !exchangeSymbol) { setRemoteSeries({}); return; }
    let cancelled = false;
    let pulling = false;
    const controller = new AbortController();
    const pull = async () => {
      if (cancelled || pulling) return;
      pulling = true;
      try {
      const requested = analysisTfs.filter(tf => tf !== timeframe && TIMEFRAMES.includes(tf as Timeframe));
      if (!requested.length) { if (!cancelled) setRemoteSeries({}); return; }
      const rows = await Promise.all(requested.map(async tf => {
        try {
          const limit = Math.min(1000, Math.max(250, settings.levelHistory || 500, settings.trendHistory || 300));
          const result = await fetchSharedAnalysisKlines(exchange, marketType, symbol, tf as Timeframe, limit);
          return [tf, toHookCandles(result)] as const;
        } catch {
          return [tf, [] as Candle[]] as const;
        }
      }));
      if (!cancelled && !controller.signal.aborted) setRemoteSeries(Object.fromEntries(rows.filter(([, values]) => values.length)));
      } finally {
        pulling = false;
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 60_000);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); };
  }, [exchange, marketType, symbol, timeframe, replay, !!externalData, analysisTfKey, settings.levelHistory, settings.trendHistory]);

  const analysisSeries = useMemo(() => {
    const series: Record<string, Candle[]> = { [timeframe]: candles };
    for (const tf of analysisTfs) {
      if (tf === timeframe) continue;
      if (remoteSeries[tf]?.length) {
        series[tf] = remoteSeries[tf];
        continue;
      }
      const aggregated = aggregateCandles(candles, timeframe, tf);
      if (aggregated.length) series[tf] = aggregated;
    }
    return series;
  }, [candles, timeframe, analysisTfKey, remoteSeries]);
  const autoLevels = useMemo(() => (settings.levelIntervals || []).flatMap(tf => {
    if (!LEVEL_TFS.has(tf as LevelTf)) return [];
    const series = analysisSeries[tf] || [];
    if (series.length < 40) return [];
    return deriveAutoLevels(series, tf as LevelTf, {
      count: settings.levelCount ?? 3,
      allowedDiffPct: settings.levelDiff ?? .18,
      historyDepth: settings.levelHistory ?? 500,
      breakPct: settings.levelBreak ?? .35,
      pivotBars: settings.levelCandleCount ?? 15,
      allowWickPenetration: settings.allowWick !== false,
    });
  }), [analysisSeries, (settings.levelIntervals || []).join(','), settings.levelCount, settings.levelDiff, settings.levelHistory, settings.levelBreak, settings.levelCandleCount, settings.allowWick]);
  const visibleAutoLevels = useMemo(() => settings.showBrokenLevels === false ? autoLevels.filter(level => !level.broken) : autoLevels, [autoLevels, settings.showBrokenLevels]);
  const strategyResult = useMemo(() => activeStrategy && candles.length ? evaluateStrategy(activeStrategy, {
    series: analysisSeries,
    chartCandles: candles,
    levels: autoLevels,
    densities: liveFeed.densities,
    book: liveFeed.book,
    oiHistory: exchange === 'bybit' ? oi.bybit : oi.binance,
    fundingHistory: liveFeed.fundingHistory,
    fundingRate: liveFeed.fundingRate,
    currentPrice: candles.at(-1)?.c || 0,
    cascadeRisk: liveFeed.cascadeRisk.score,
  }) : null, [
    activeStrategy?.id, analysisSeries, candles, autoLevels, oi.binance, oi.bybit, exchange,
    liveFeed.densities, liveFeed.book, liveFeed.fundingHistory, liveFeed.fundingRate, liveFeed.cascadeRisk.score,
  ]);
  const chartToolbarEnabled = replay || settings.chartToolbar !== false;
  // Terminal extras must open visibly below the crowded chart controls.
  // Other HookChart pages keep using the saved toolbar preference.
  const topToolbarOpen = replay ? replayToolsOpen : (integratedToolbar ? terminalExtraToolsOpen : settings.showTopToolbarIcons !== false);
  const drawingToolbarOpen = replay ? replayDrawingToolbarOpen : chartToolbarEnabled && (
    terminalMode && terminalToolbarVisibility
      ? terminalToolbarVisibility.drawingToolsOpen
      : settings.drawingToolbarOpen === true
  );
  const rightPaddingBars = activeVisualProfile ? 0 : terminalMode ? 8 : settings.rightPaddingEnabled === false ? 0 : (settings.rightPadding ?? 10);
  const channel = useMemo(() => (replay ? replayOverlays.includes('channel') : settings.autoChannel)
    ? buildStructuralChannel(analysisSeries, candles.at(-1)?.c) : null,
    [analysisSeries, candles, settings.autoChannel, replay, replayOverlays]);
  // The previous footer displayed a permanent placeholder for BTC correlation
  // and summed missing candle.tradeCount values as if they were true trades.
  // Both values now use verified exchange data and are scoped to this instrument.
  const statsScope = [exchange, marketType, normalizeExchangeSymbol(symbol), timeframe].join(':');
  const [btcReference, setBtcReference] = useState<{ scope: string; rows: Kline[] } | null>(null);
  const [tradeCount24h, setTradeCount24h] = useState<{ scope: string; count: number | null } | null>(null);

  useEffect(() => {
    if (replay || externalData || settings.showMarketStatsBar === false) return;
    const cleanedSymbol = normalizeExchangeSymbol(symbol);
    const benchmark = btcBenchmarkSymbol(cleanedSymbol);
    if (!/^[A-Z0-9]{3,30}$/.test(cleanedSymbol)) return;
    const controller = new AbortController();
    let fetching = false;
    const pull = async () => {
      if (fetching || controller.signal.aborted) return;
      fetching = true;
      try {
        // Fetch only the benchmark matching this exchange, market and timeframe;
        // never correlate with spot BTC when the chart is futures (or vice versa).
        const btcRequest = benchmark && benchmark !== cleanedSymbol
          ? (async () => {
              const params = new URLSearchParams({
                exchange, market: marketType, symbol: benchmark, timeframe, limit: '250',
              });
              try {
                const response = await fetch('/api/klines?' + params, { signal: controller.signal });
                if (!response.ok) throw new Error('BTC candles unavailable');
                const data = await response.json();
                if (!controller.signal.aborted) setBtcReference({
                  scope: statsScope, rows: data.success && Array.isArray(data.data) ? data.data : [],
                });
              } catch {
                if (!controller.signal.aborted) setBtcReference({ scope: statsScope, rows: [] });
              }
            })()
          : Promise.resolve();
        const tradesRequest = (async () => {
          try {
            if (exchange !== 'binance') return;
            const params = new URLSearchParams({ exchange, market: marketType, symbol: cleanedSymbol });
            const response = await fetch('/api/chart/trades24h?' + params, { signal: controller.signal });
            if (!response.ok) throw new Error('Trade count unavailable');
            const data = await response.json();
            const count = data.success && Number.isSafeInteger(data.trades24h) && data.trades24h >= 0
              ? data.trades24h as number : null;
            if (!controller.signal.aborted) setTradeCount24h({ scope: statsScope, count });
          } catch {
            if (!controller.signal.aborted) setTradeCount24h({ scope: statsScope, count: null });
          }
        })();
        await Promise.all([btcRequest, tradesRequest]);
      } finally { fetching = false; }
    };
    void pull();
    const timer = setInterval(() => void pull(), 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [statsScope, exchange, marketType, symbol, timeframe, replay, !!externalData, settings.showMarketStatsBar]);

  const btcCorrelation = useMemo(() => {
    if (replay || externalData || !TF_MS[timeframe]) return null;
    const benchmark = btcBenchmarkSymbol(normalizeExchangeSymbol(symbol));
    if (!benchmark) return null;
    // BTC compared with itself has +1 correlation if enough valid closed bars.
    const current = candles.map(c => ({ time: Math.round(c.t / 1000), close: c.c }));
    const reference = benchmark === normalizeExchangeSymbol(symbol)
      ? current
      : btcReference?.scope === statsScope ? btcReference.rows : [];
    return calculateBtcCorrelation(current, reference, TF_MS[timeframe]);
  }, [candles, btcReference, statsScope, symbol, timeframe, replay, !!externalData]);

  const marketStats = useMemo(() => {
    const last = candles.at(-1);
    if (!last) return { vol24: 0, high: 0, low: 0, natr: NaN };
    const day = candles.filter(candle => candle.t >= last.t - 86_400_000);
    return {
      vol24: day.reduce((sum, candle) => sum + (candle.v || 0) * candle.c, 0),
      high: day.length ? Math.max(...day.map(candle => candle.h)) : last.h,
      low: day.length ? Math.min(...day.map(candle => candle.l)) : last.l,
      natr: last.c > 0 ? atr(candles, Math.max(2, settings.natrPeriod || 14)) / last.c * 100 : NaN,
    };
  }, [candles, settings.natrPeriod]);

  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const delta = pending.current;
    const owner = pendingOwnerUid.current;
    if (!delta || !owner) return;
    if (owner !== activeUid.current || owner !== user?.uid) {
      pending.current = null;
      pendingOwnerUid.current = null;
      return;
    }
    // A newly signed-in profile may still be loading. Wait for its data
    // instead of overwriting an unknown profile with default settings.
    if (profile?.uid !== owner) return;
    pending.current = null;
    pendingOwnerUid.current = null;
    savingByUid.current.set(owner, (savingByUid.current.get(owner) || 0) + 1);
    void saveRef.current({ hookChartPreferences: delta })
      .then(() => { if (mounted.current && activeUid.current === owner) setSaveError(false); })
      .catch(() => {
        if (!mounted.current || activeUid.current !== owner) return;
        pendingOwnerUid.current = owner;
        pending.current = {
          ...delta, ...pending.current,
          drawings: { ...delta.drawings, ...pending.current?.drawings },
          alerts: { ...delta.alerts, ...pending.current?.alerts },
        };
        setSaveError(true);
      })
      .finally(() => {
        const remaining = (savingByUid.current.get(owner) || 1) - 1;
        if (remaining > 0) savingByUid.current.set(owner, remaining);
        else savingByUid.current.delete(owner);
        // Rehydrate once the write finishes; the server snapshot may have
        // arrived while this chart was intentionally protecting local edits.
        if (mounted.current && activeUid.current === owner) refreshProfileSettings(value => value + 1);
      });
  }, [user?.uid, profile?.uid]);

  const queueSave = useCallback((delta: HookChartPreferences) => {
    if (!user) return;
    if (pendingOwnerUid.current && pendingOwnerUid.current !== user.uid) {
      pending.current = null;
    }
    pendingOwnerUid.current = user.uid;
    pending.current = {
      ...pending.current,
      ...delta,
      drawings: { ...pending.current?.drawings, ...delta.drawings },
      alerts: { ...pending.current?.alerts, ...delta.alerts },
    };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 600);
  }, [user?.uid, flush]);

  useEffect(() => {
    if (user?.uid && profile?.uid === user.uid &&
      pendingOwnerUid.current === user.uid && pending.current && !saveTimer.current) flush();
  }, [profile?.uid, user?.uid, flush]);

  useEffect(() => {
    const uid = user?.uid ?? null;
    if (lastLoadedUid.current !== uid) {
      lastLoadedUid.current = uid;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      pending.current = null;
      pendingOwnerUid.current = null;
      setSaveError(false);
    } else if (
      (pending.current && pendingOwnerUid.current === uid) ||
      (uid && (savingByUid.current.get(uid) || 0) > 0)
    ) return;
    if (user && profile?.uid !== user.uid) {
      setSettings(normalizeOriginalHookChartPreferences());
      drawingsRef.current = [];
      alertsRef.current = [];
      setDrawingsState([]);
      setAlertsState([]);
      return;
    }
    const hydrated = normalizeOriginalHookChartPreferences(preferences);
    setSettings(hydrated);
    // Use the incoming account preference, not stale local state, to select the
    // drawing scope. Otherwise changing sharedDrawings can restore the wrong set.
    const next = replay ? [] : (hydrated.sharedDrawings !== false ? preferences?.drawings?.[sharedScope] : undefined) || preferences?.drawings?.[scope] || [];
    const nextAlerts = replay ? [] : (hydrated.sharedDrawings !== false ? preferences?.alerts?.[sharedScope] : undefined) || preferences?.alerts?.[scope] || [];
    drawingsRef.current = next;
    alertsRef.current = nextAlerts;
    setDrawingsState(next);
    setAlertsState(nextAlerts);
  }, [user?.uid, profile?.uid, preferences, scope, sharedScope, profileSyncVersion, replay]);

  useEffect(() => {
    if (user && profile?.uid !== user.uid) return;
    if (settings.siteLanguageAtSelection === siteLanguage) return;
    const delta = { language: siteLanguage, siteLanguageAtSelection: siteLanguage };
    setSettings(current => ({ ...current, ...delta }));
    if (!replay) queueSave(delta);
  }, [siteLanguage, settings.siteLanguageAtSelection, user?.uid, profile?.uid, queueSave, replay]);

  useEffect(() => {
    mounted.current = true;
    const onPageHide = () => flush();
    window.addEventListener('pagehide', onPageHide);
    return () => { mounted.current = false; window.removeEventListener('pagehide', onPageHide); flush(); };
  }, [flush]);

  const setDrawings: React.Dispatch<React.SetStateAction<Drawing[]>> = useCallback(update => {
    const next = typeof update === 'function' ? update(drawingsRef.current) : update;
    drawingsRef.current = next;
    setDrawingsState(next);
    if (!replay) queueSave({ drawings: settings.sharedDrawings !== false ? { [scope]: next, [sharedScope]: next } : { [scope]: next } });
  }, [scope, sharedScope, settings.sharedDrawings, queueSave, replay]);

  const setAlerts: React.Dispatch<React.SetStateAction<Alert[]>> = useCallback(update => {
    const next = typeof update === 'function' ? update(alertsRef.current) : update;
    alertsRef.current = next;
    setAlertsState(next);
    if (!replay) queueSave({ alerts: settings.sharedDrawings !== false ? { [scope]: next, [sharedScope]: next } : { [scope]: next } });
  }, [scope, sharedScope, settings.sharedDrawings, queueSave, replay]);

  // The bell must create a real server-monitored Telegram price alert, not
  // merely a drawing persisted under hookChartPreferences. Live active server
  // alerts are projected onto any matching chart, regardless of timeframe.
  const livePriceMarkers = useMemo(
    () => chartTelegramAlerts(priceAlerts, symbol, exchange, marketType),
    [priceAlerts, symbol, exchange, marketType]
  );
  const visiblePriceMarkers = useMemo(() => replay ? alerts : [...alerts, ...livePriceMarkers], [replay, alerts, livePriceMarkers]);
  const selectedTelegramAlertId = selectedPriceMarker
    ? telegramIdFromChartMarker(selectedPriceMarker, symbol) : null;
  const selectedPriceAlert = selectedTelegramAlertId
    ? priceAlerts.find(alert => alert.id === selectedTelegramAlertId) : null;
  const selectedLocalMarker = selectedPriceMarker
    ? alerts.find(alert => alert.id === selectedPriceMarker) : null;

  const createTelegramPriceAlert = useCallback(async (selectedPrice: number) => {
    if (creatingPriceAlert.current) return;
    if (replay) {
      setAlertNotice({ text: 'У режимі відтворення Telegram-сповіщення недоступні.', error: true });
      return;
    }
    if (!user) {
      setAlertNotice({ text: 'Увійдіть в акаунт, щоб встановити Telegram-сповіщення.', error: true });
      return;
    }
    if (!telegramStatus?.isConfigured) {
      setAlertNotice({ text: 'Спочатку підключіть Telegram у розділі «Сповіщення».', error: true });
      return;
    }
    const currentPrice = candles.at(-1)?.c;
    if (!Number.isFinite(selectedPrice) || selectedPrice <= 0 ||
        !currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) {
      setAlertNotice({ text: 'Не вдалося визначити поточну ціну монети.', error: true });
      return;
    }
    // The same physical price alert is independent of candle timeframe.
    const normalizedSymbol = normalizeExchangeSymbol(symbol);
    const condition = alertConditionForPrice(selectedPrice, currentPrice);
    const alreadyActive = priceAlerts.some(alert =>
      alert.symbol === normalizedSymbol &&
      alert.exchange === exchange && alert.marketType === marketType &&
      alert.isActive && !alert.triggered &&
      alert.condition === condition &&
      Math.abs(alert.targetPrice - selectedPrice) <= Math.max(selectedPrice * 0.000001, 1e-10)
    );
    if (alreadyActive) {
      setAlertNotice({ text: 'На цій ціні вже існує активне сповіщення.', error: true });
      return;
    }

    creatingPriceAlert.current = true;
    setAlertNotice(null);
    try {
      await addAlert({
        symbol: normalizedSymbol,
        exchange,
        marketType,
        targetPrice: selectedPrice,
        condition,
        levelType: 'custom',
        formationName: focusFormation?.name,
        note: `Графік: ${condition === 'gte' ? 'ціна ≥' : 'ціна ≤'} ${selectedPrice}`,
      });
      setTool('cursor');
      setAlertNotice({ text: `Telegram-сповіщення створено: ${condition === 'gte' ? '≥' : '≤'} ${selectedPrice}`, error: false });
    } catch (error) {
      setAlertNotice({ text: error instanceof Error ? error.message : 'Не вдалося зберегти сповіщення.', error: true });
    } finally {
      creatingPriceAlert.current = false;
    }
  }, [replay, user, telegramStatus?.isConfigured, candles, symbol, priceAlerts, exchange, marketType, addAlert, focusFormation?.name]);

  const confirmDeletePriceMarker = useCallback(async () => {
    if (!selectedPriceMarker || deletingPriceMarker) return;
    const telegramId = telegramIdFromChartMarker(selectedPriceMarker, symbol);
    setDeletingPriceMarker(true);
    try {
      if (telegramId) {
        const deleted = await deleteAlert(telegramId);
        if (!deleted) throw new Error('Не вдалося видалити Telegram-сповіщення.');
      } else {
        setAlerts(existing => existing.filter(alert => alert.id !== selectedPriceMarker));
      }
      setSelectedPriceMarker(null);
      setAlertNotice({ text: 'Мітку та пов’язане сповіщення видалено.', error: false });
    } catch (error) {
      setAlertNotice({ text: error instanceof Error ? error.message : 'Не вдалося видалити мітку.', error: true });
    } finally {
      setDeletingPriceMarker(false);
    }
  }, [selectedPriceMarker, deletingPriceMarker, symbol, deleteAlert, setAlerts]);

  const changeSettings = (delta: HookChartPreferences) => {
    if (replay) { setSettings(current => ({ ...current, ...delta })); return; }
    if (externalData?.onAppearanceChange && (delta.candleLongColor !== undefined || delta.candleShortColor !== undefined || delta.showVolumes !== undefined))
      externalData.onAppearanceChange({ ...(delta.candleLongColor !== undefined ? { upColor: delta.candleLongColor } : {}),
        ...(delta.candleShortColor !== undefined ? { downColor: delta.candleShortColor } : {}), ...(delta.showVolumes !== undefined ? { volume: delta.showVolumes } : {}) });
    if (delta.language) delta = { ...delta, siteLanguageAtSelection: siteLanguage };
    setSettings(current => ({ ...current, ...delta, hotkeys: delta.hotkeys ? { ...current.hotkeys, ...delta.hotkeys } : current.hotkeys }));
    queueSave({
      ...(preferences?.rightPaddingVersion !== 2 ? {
        rightPadding: settings.rightPadding,
        rightPaddingEnabled: settings.rightPaddingEnabled,
        rightPaddingVersion: 2,
      } : {}),
      ...delta,
    });
  };
  const captureCurrentVisual = (key: VisualProfileKey) => {
    if (replay || key !== activeVisualKey) return;
    const plotWidth = hookChartPlotWidth(rootRef.current?.clientWidth || 800);
    const count = Math.max(1,Math.ceil(plotWidth/Math.max(.12,viewport.barWidth)));
    const right = Math.max(0,Math.floor(viewport.rightOffset));
    const end = Math.max(0,candles.length-right);
    const visible = candles.slice(Math.max(0,end-count),end);
    let low=Infinity,high=-Infinity;
    for (const item of visible){low=Math.min(low,item.l);high=Math.max(high,item.h)}
    const autoRange=Number.isFinite(high)&&Number.isFinite(low)
      ? Math.max(high-low,Math.abs(high)*.01,1e-10)*(terminalMode?1.32:1.16) : undefined;
    const profile = captureVisualProfile(getVisualProfile(settings,activeVisualContext,visualDevice),plotWidth,viewport,autoRange);
    changeSettings({ visualProfiles: patchVisualProfile(settings.visualProfiles,key,profile) });
  };
  const toggleIndicator = (id: IndicatorId) => {
    if (replay) {
      if (id === 'oi') return;
      setReplayIndicators(current => current.includes(id)
        ? current.filter(item => item !== id) : [...current, id]);
      return;
    }
    const current = enabledIndicators(settings, false, 'futures');
    changeSettings({ indicators: current.includes(id) ? current.filter(x => x !== id) : [...current, id] });
  };
  const overlayKeys = { sr: 'autoSR', prevDay: 'autoPrevDay', dayOpen: 'autoDayOpen', vwap: 'autoVWAP', localHL: 'autoLocalHL', roundLevels: 'autoRoundLevels', poc: 'autoPOC', channel: 'autoChannel', stops: 'autoStops' } as const;
  const overlayEnabled = (id: string) => replay
    ? replayOverlays.includes(id) : !!settings[overlayKeys[id as keyof typeof overlayKeys]];
  const toggleOverlay = (id: string) => {
    if (replay) {
      setReplayOverlays(current => current.includes(id)
        ? current.filter(item => item !== id) : [...current, id]);
      return;
    }
    const key = overlayKeys[id as keyof typeof overlayKeys];
    if (!key) return;
    const overlays = settings.overlays || [];
    const enabled = !!settings[key];
    changeSettings({
      [key]: !enabled,
      overlays: enabled ? overlays.filter(item => item !== id) : Array.from(new Set([...overlays, id])),
    } as HookChartPreferences);
  };
  const applyStrategy = (id: string) => {
    const patch = strategyPreferencePatch(id);
    if (patch) changeSettings(patch);
  };
  const toggleDrawingToolbar = () => {
    if (!chartToolbarEnabled) return;
    if (replay) setReplayDrawingToolbarOpen(current => !current);
    else if (terminalMode && terminalToolbarVisibility)
      terminalToolbarVisibility.onDrawingToolsOpenChange(!drawingToolbarOpen);
    else changeSettings({ drawingToolbarOpen: !drawingToolbarOpen });
    setPanel(null);
    setTool('cursor');
  };

  useEffect(() => {
    if (!drawingToolbarOpen) {
      setTool('cursor');
      setPanel(current => current === 'indicators' ? null : current);
    }
  }, [drawingToolbarOpen]);

  useEffect(() => {
    const hotkeys = { ...DEFAULT_HOOKCHART_HOTKEYS, ...(settings.hotkeys || {}) };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!rootRef.current?.contains(document.activeElement)) return;
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (typing && event.key !== 'Escape') return;
      const use = (action: keyof typeof hotkeys) => hotkeyMatches(event, hotkeys[action]);
      if (use('tempRuler')) { if (!event.repeat && !tempRulerRef.current) { event.preventDefault(); tempRulerRef.current = { code: event.code, tool }; setTool('ruler'); } return; }
      if (use('cancel')) { event.preventDefault(); setTool('cursor'); setPanel(null); setDensityQuickOpen(false); return; }
      if (use('zoomIn')) { event.preventDefault(); engineRef.current?.zoom(1.18); return; }
      if (use('zoomOut')) { event.preventDefault(); engineRef.current?.zoom(0.84); return; }
      if (use('copyTicker')) { event.preventDefault(); void navigator.clipboard?.writeText(symbol); return; }
      if (use('openWindow')) { event.preventDefault(); window.open(window.location.href, '_blank', 'noopener,noreferrer'); return; }
      if (use('level')) { event.preventDefault(); setTool('level'); return; }
      if (use('trend')) { event.preventDefault(); setTool('trend'); return; }
      if (use('ray')) { event.preventDefault(); setTool('ray'); return; }
      if (use('fib')) { event.preventDefault(); setTool('fib'); return; }
      if (use('erase')) { event.preventDefault(); setTool(current => current === 'erase' ? 'cursor' : 'erase'); return; }
      if (use('clearAlerts')) { event.preventDefault(); setAlerts([]); return; }
      if (use('signalLevel')) { event.preventDefault(); setTool('alert'); return; }
      const choices = externalData?.timeframes || TIMEFRAMES, index = choices.indexOf(timeframe);
      const changeTimeframe = externalData?.onTimeframeChange || onTimeframeChange;
      if (changeTimeframe && !replay && use('prevTf')) { event.preventDefault(); changeTimeframe(choices[Math.max(0, index - 1)] as Timeframe); return; }
      if (changeTimeframe && !replay && use('nextTf')) { event.preventDefault(); changeTimeframe(choices[Math.min(choices.length - 1, index + 1)] as Timeframe); return; }
      for (const action of ['openMetaScalp', 'deleteCoin', 'toggleFavorites', 'prevCoin', 'nextCoin', 'prevChart', 'nextChart', 'prevTfAll', 'nextTfAll'] as const) {
        if (use(action)) {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent('signalhook:hookchart-hotkey', { detail: { action, symbol, exchange, marketType, timeframe } }));
          return;
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const active = tempRulerRef.current;
      if (active && event.code === active.code) {
        setTool(active.tool);
        tempRulerRef.current = null;
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [settings.hotkeys, symbol, exchange, marketType, timeframe, replay, onTimeframeChange, externalData?.timeframes, externalData?.onTimeframeChange, tool]);

  // Replay is deliberately isolated: only the simulator's visible candles are passed to the engine.
  const needHistory = useCallback(async (timestamp: number) => {
    if (replay || timestamp > Date.now()) return false;
    if (externalData) return externalData.onNeedHistory(timestamp);
    const { allCandles: rows } = await fetchHistoricalReplayCandles(exchange, marketType, symbol, timeframe as Timeframe, timestamp);
    if (!mounted.current) return false;
    if (!rows.some(row => Math.abs(row.time * 1000 - timestamp) < 86_400_000)) return false;
    setExtraHistory(previous => ({
      scope: historyScope,
      rows: [...scopedHookChartHistoryRows(previous, historyScope), ...rows].slice(-40_000),
    }));
    return true;
  }, [exchange, marketType, symbol, timeframe, replay, historyScope, externalData?.onNeedHistory]);

  useEffect(() => {
    if (!externalData || !candles.length || viewport.fitAll) return;
    const width = rootRef.current?.clientWidth || 600;
    const start = candles.length - viewport.rightOffset - width / Math.max(.12, viewport.barWidth);
    if (start < 25) void externalData.onNeedHistory(candles[0].t - 1);
  }, [candles[0]?.t, candles.length, viewport.rightOffset, viewport.barWidth, viewport.fitAll, externalData?.onNeedHistory]);

  useEffect(() => {
    if (focusTrigger !== undefined) engineRef.current?.zoomToLatest();
  }, [focusTrigger]);

  const showOi = indicators.includes('oi') || !!activeStrategy;
  useEffect(() => {
    if (!showOi || replay || externalData || marketType !== 'futures') { setOi(EMPTY_OI); setOiError(false); return; }
    const controller = new AbortController();
    const poll = async () => {
      try {
        const query = new URLSearchParams({ symbol: normalizeExchangeSymbol(symbol), timeframe });
        const response = await fetch(`/api/derivatives/oi/history?${query}`, { signal: controller.signal });
        if (!response.ok) throw new Error('OI unavailable');
        const data = await response.json();
        if (!data.success || (!data.binance?.length && !data.bybit?.length)) throw new Error('OI unavailable');
        if (!controller.signal.aborted) { setOi({ binance: data.binance || [], bybit: data.bybit || [] }); setOiError(false); }
      } catch { if (!controller.signal.aborted) setOiError(true); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [showOi, symbol, timeframe, replay, marketType, !!externalData]);

  const assignRef = useCallback((handle: HookChartHandle | null) => {
    engineRef.current = handle;
    if (typeof forwardedRef === 'function') forwardedRef(handle);
    else if (forwardedRef) forwardedRef.current = handle;
  }, [forwardedRef]);

  // Keep popovers outside the horizontally scrolling strip so they are not clipped.
  const toolbarPopup = (popup: React.ReactNode) => rootRef.current
    ? createPortal(popup, rootRef.current) : popup;
  const availableTimeframes = externalData?.timeframes || TIMEFRAMES;
  const canChangeTimeframe = !!(externalData || onTimeframeChange);
  const selectTimeframe = (tf: string) => {
    if (externalData) externalData.onTimeframeChange(tf);
    else onTimeframeChange?.(tf as Timeframe);
  };
  const timeframePicker = canChangeTimeframe
    ? <HookChartTimeframePicker
        timeframes={availableTimeframes}
        timeframe={timeframe}
        disabled={replay && timeframeDisabled}
        compactAvailable={topToolbarOpen}
        onChange={selectTimeframe}
      />
    : <div className="hookchart-timeframes" role="group" aria-label="Таймфрейм">
        <span>{timeframe}</span>
      </div>;

  return <div ref={rootRef} className={'hookchart-root' + (terminalMode ? ' hookchart-terminal' : '')} data-chart-provider="hookchart" data-extra-tools-open={topToolbarOpen ? 'true' : 'false'} data-hookchart-language={chartLanguage} lang={chartLanguage}>
    <div ref={toolbarRef} className={'hookchart-toolbar' + (integratedToolbar ? ' hookchart-terminal-toolbar' : '')} role="toolbar" aria-label="Верхня панель hookchart" aria-orientation="horizontal">
      {integratedToolbar ? <div className="hookchart-terminal-scroll" role="group" aria-label="Монета, біржа та таймфрейми">
        <div className="hookchart-toolbar-actions" role="group" aria-label="Інструменти блока">{toolbarActions}</div>
        {timeframePicker}
      </div> : timeframePicker}

      <button
        type="button"
        className="topToolbarToggle"
        aria-expanded={topToolbarOpen}
        aria-label={topToolbarOpen ? 'Згорнути панель інструментів HookChart' : 'Розгорнути панель інструментів HookChart'}
        title={settings.tooltips !== false ? (topToolbarOpen ? 'Згорнути панель інструментів' : 'Розгорнути панель інструментів') : undefined}
        onClick={() => {
          if (replay) setReplayToolsOpen(current => !current);
          else if (integratedToolbar && terminalToolbarVisibility)
            terminalToolbarVisibility.onExtraToolsOpenChange(!terminalExtraToolsOpen);
          else if (integratedToolbar) changeSettings({ terminalExtraToolsOpen: !terminalExtraToolsOpen });
          else changeSettings({ showTopToolbarIcons: !topToolbarOpen });
          setDensityQuickOpen(false);
        }}
      >
        {topToolbarOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>

      {replay && !topToolbarOpen && onReplayPlaybackSpeedChange && (
        <ReplaySpeedPicker speed={replayPlaybackSpeed ?? 1} onSpeedChange={onReplayPlaybackSpeedChange} />
      )}

      {!integratedToolbar && toolbarActions && <div className="hookchart-toolbar-actions" role="group" aria-label="Інструменти блока">{toolbarActions}</div>}

      {/* Standalone quick charts keep these tools inline with timeframes.
          Integrated terminal charts retain their separate dock. */}
      {topToolbarOpen && <div className={'hookchart-extra-dock ' + (integratedToolbar ? 'hookchart-terminal-extra-dock' : 'hookchart-standalone-extra-dock')} role="group" aria-label="Додаткові інструменти HookChart">
        {integratedToolbar && <button type="button" className="hookchart-extra-nav" title="Прокрутити інструменти вліво" aria-label="Прокрутити додаткові інструменти вліво" onClick={() => scrollExtraTools(-1)}>
          <ChevronLeft size={15} />
        </button>}
        <div
          ref={extraToolsRef}
          className={integratedToolbar ? 'hookchart-terminal-extra-row' : 'hookchart-standalone-extras'}
          role="group"
          aria-label="Прокручуваний список додаткових інструментів"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              scrollExtraTools(event.key === 'ArrowLeft' ? -1 : 1);
            }
          }}
        >
          {/* A max-content inner rail prevents flex items from shrinking to the
              viewport. Without real overflow there is nothing for wheel/touch
              scrolling to move, even with a working event handler. */}
          <div className="hookchart-extras-content">
        {!replay && tradeLevelToggle && <button
          type="button"
          className={'trade-level-toggle-button' + (tradeLevelToggle.visible && tradeLevelToggle.available !== false ? ' active' : '')}
          aria-label={tradeLevelToggle.available === false ? 'TP/SL: немає розрахованих рівнів для цієї монети' : tradeLevelToggle.visible ? 'Приховати TP, Вхід і SL' : 'Показати TP, Вхід і SL'}
          title={tradeLevelToggle.available === false ? 'TP/SL стане доступним, коли будуть розраховані Вхід, Ціль і Стоп' : tradeLevelToggle.visible ? 'Приховати всі три мітки: TP, Вхід, SL' : 'Показати всі три мітки: TP, Вхід, SL'}
          aria-pressed={tradeLevelToggle.visible}
          disabled={tradeLevelToggle.available === false}
          onClick={tradeLevelToggle.onToggle}
        >
          <Target size={14} />
          <span>TP/SL</span>
        </button>}


        {!replay && <div className="densityQuickWrap">
          <button
            type="button"
            title={settings.tooltips !== false ? 'Поріг щільностей' : undefined}
            aria-label="Поріг щільностей"
            aria-expanded={densityQuickOpen}
            className={densityQuickOpen ? 'active' : ''}
            onClick={(event) => {
              if (!integratedToolbar && rootRef.current) {
                const rootBounds = rootRef.current.getBoundingClientRect();
                const triggerBounds = event.currentTarget.getBoundingClientRect();
                setDensityPopupLeft(Math.max(8, Math.min(triggerBounds.left - rootBounds.left, rootBounds.width - 226)));
              }
              setDensityQuickOpen(value => !value);
            }}
          >
            <Layers size={15} />
          </button>
          {densityQuickOpen && toolbarPopup(<div className="densityQuickPopup" style={!integratedToolbar ? { left: densityPopupLeft, top: 32 } : undefined}>
            <div className="densityQuickHead">
              <span>Поріг щільностей</span>
              <b>{liveFeed.densityCut > 0 ? <>≥ &#36;{liveFeed.densityCut.toLocaleString()}</> : '—'} · {chartDensities.length}/{liveFeed.densities.length}</b>
            </div>
            <div className="densityQuickStatus" role="status" data-live={liveFeed.depthReady && liveFeed.densityCut > 0}>
              {liveFeed.depthReady
                ? (liveFeed.densityCut > 0 ? 'Стакан наживо' : settings.densityMode === 'manual' ? 'Недостатньо заявок у діапазоні' : 'Недостатньо рівнів для AUTO')
                : liveFeed.depthStatus === 'disabled' ? 'Живий стакан вимкнено у відтворенні'
                : liveFeed.depthStatus === 'unavailable' ? 'Біржовий стакан недоступний'
                : liveFeed.depthStatus === 'reconnecting' ? 'Відновлення стакана'
                : liveFeed.depthStatus === 'syncing' ? 'Синхронізація стакана' : 'Підключення стакана'}
            </div>
            {settings.densityMode !== 'manual' && liveFeed.depthReady && liveFeed.densityAutoStats.baseline > 0 && <div className="densityQuickAutoStats">
              <div><span>BID (проти продажів)</span><b>${liveFeed.densityAutoStats.bidCut.toLocaleString()}</b></div>
              <div><span>ASK (проти покупок)</span><b>${liveFeed.densityAutoStats.askCut.toLocaleString()}</b></div>
              <small>4× медіана · частка локального стакана ≥25% · зустрічні угоди 5 хв ×0,5</small>
            </div>}
            <div className="densityQuickModes">
              <button type="button" className={settings.densityMode !== 'manual' ? 'sel' : ''} onClick={() => {
                setDensityThresholdDraft(null);
                changeSettings({ densityMode: 'auto', densityAnalysis: true,
                  showDensityLines: true, showDensityLabels: true, showDensityAmounts: true });
              }}>AUTO</button>
              <button type="button" className={settings.densityMode === 'manual' ? 'sel' : ''} onClick={() => {
                const seed = settings.densityMode === 'manual' && (settings.densityThreshold || 0) > 0
                  ? settings.densityThreshold! : Math.max(1, Math.ceil(liveFeed.densityCut || settings.densityThreshold || 50_000));
                setDensityThresholdDraft(null);
                changeSettings({ densityMode: 'manual', densityThreshold: seed,
                  showDensityLines: true, showDensityLabels: true, showDensityAmounts: true });
              }}>MANUAL</button>
            </div>
            {settings.densityMode !== 'manual' && <div className="densityQuickReaction">
              <div className="densityQuickTierModes" role="group" aria-label="Фільтр реакції щільностей">
                <button type="button" aria-pressed={(settings.densityAutoDisplay || 'potential') === 'all'}
                  className={(settings.densityAutoDisplay || 'potential') === 'all' ? 'sel' : ''}
                  onClick={() => changeSettings({ densityAutoDisplay: 'all' })}>Усі сильні</button>
                <button type="button" aria-pressed={(settings.densityAutoDisplay || 'potential') === 'potential'}
                  className={(settings.densityAutoDisplay || 'potential') === 'potential' ? 'sel' : ''}
                  onClick={() => changeSettings({ densityAutoDisplay: 'potential' })}>Потенціал реакції</button>
              </div>
              <small>Високий потенціал: {potentialDensityCount} із {liveFeed.densities.length}. Вік ≥30 с, дотик ціни, виконання угод або поповнення. Рейтинг не є % ймовірності.</small>
              {liveFeed.depthReady && liveFeed.densities.length > 0 && potentialDensityCount === 0 &&
                <small>Поки немає підтверджень. Перемкни «Усі сильні», щоб бачити заявки до контакту з ціною.</small>}
            </div>}
            <label className="densityQuickInput">
              <span>$</span>
              <input
                type="number"
                min="1"
                step="1"
                aria-label="Поріг щільностей (USDT)"
                placeholder="Очікування даних"
                value={densityThresholdDraft ?? (settings.densityMode !== 'manual'
                  ? (liveFeed.densityCut > 0 ? String(liveFeed.densityCut) : '')
                  : String(settings.densityThreshold || ''))}
                onFocus={event => {
                  setDensityThresholdDraft(event.currentTarget.value);
                  event.currentTarget.select();
                }}
                onChange={event => {
                  const value = event.target.value;
                  setDensityThresholdDraft(value);
                  const threshold = Number(value);
                  if (value && Number.isFinite(threshold) && threshold >= 1) {
                    changeSettings({ densityMode: 'manual', densityThreshold: Math.round(threshold),
                      showDensityLines: true, showDensityLabels: true, showDensityAmounts: true });
                  }
                }}
                onBlur={() => {
                  setDensityThresholdDraft(null);
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            </label>
            <label className="densityHoldInput">
              <span>Дистанція від ціни</span>
              <input
                type="number"
                inputMode="decimal"
                min="0.1"
                max="20"
                step="0.1"
                aria-label="Дистанція щільностей (%)"
                value={densityDistanceDraft ?? normalizeDensityDistance(settings.densityDiffPct)}
                onFocus={event => {
                  setDensityDistanceDraft(event.currentTarget.value);
                  event.currentTarget.select();
                }}
                onChange={event => {
                  const draft = event.currentTarget.value;
                  setDensityDistanceDraft(draft);
                  const value = Number(draft);
                  if (draft && Number.isFinite(value) && value >= .1 && value <= 20) changeSettings({ densityDiffPct: value });
                }}
                onBlur={() => {
                  if (densityDistanceDraft && Number.isFinite(Number(densityDistanceDraft))) {
                    changeSettings({ densityDiffPct: normalizeDensityDistance(Number(densityDistanceDraft)) });
                  }
                  setDensityDistanceDraft(null);
                }}
                onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
              />
              <b>%</b>
            </label>
            <small className="densityQuickHint">У межах доступної глибини стакана біржі.</small>
            <div className="densityQuickVisibility">
              <button type="button" className={settings.showDensityLines ? 'on' : ''} onClick={() => changeSettings({ showDensityLines: !settings.showDensityLines })}>МІТКИ</button>
              <button
                type="button"
                className={settings.showDensityLabels && settings.showDensityAmounts ? 'on' : ''}
                onClick={() => {
                  const on = !(settings.showDensityLabels && settings.showDensityAmounts);
                  changeSettings({ showDensityLabels: on, showDensityAmounts: on });
                }}
              >
                СУМИ
              </button>
            </div>
            <label className="densityHoldInput">
              <span>Час утримання</span>
              <input
                type="number"
                min="0"
                max="7200"
                step="10"
                value={Math.round((settings.densityTimeoutMin || 0) * 60)}
                onChange={event => changeSettings({ densityTimeoutMin: Math.max(0, Number(event.target.value) || 0) / 60 })}
              />
              <b>сек</b>
            </label>
          </div>)}
        </div>}

        <div className="autoOverlayTools" role="group" aria-label="Автоматичні рівні">
          {OVERLAYS.map(([id, label]) => <button
            key={id}
            type="button"
            title={settings.tooltips !== false ? label : undefined}
            aria-label={label}
            aria-pressed={overlayEnabled(id)}
            className={overlayEnabled(id) ? 'active' : ''}
            onClick={() => toggleOverlay(id)}
          >
            <OverlayIcon kind={id} />
          </button>)}
        </div>
          </div>
        </div>
        {integratedToolbar && <button type="button" className="hookchart-extra-nav" title="Прокрутити інструменти вправо" aria-label="Прокрутити додаткові інструменти вправо" onClick={() => scrollExtraTools(1)}>
          <ChevronRight size={15} />
        </button>}
      </div>}

      <div className="toolbarRight">
        {!replay && <button
          type="button"
          title={settings.tooltips !== false ? 'Налаштування графіка' : undefined}
          aria-label="Налаштування hookchart"
          aria-expanded={panel === 'settings'}
          className={'chartSettingsBtn ' + (panel === 'settings' ? 'active' : '')}
          onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
        >
          <Settings size={14} />
        </button>}
        {chartActions && <div className="hookchart-chart-actions" role="group" aria-label="Дії графіка">
          {chartActions}
        </div>}
      </div>
    </div>

    {toolbarOverlays && <div className="hookchart-toolbar-overlays">{toolbarOverlays}</div>}

    {!replay && panel === 'settings' && typeof document !== 'undefined' && createPortal(
      <div className="hookchart-root hookchart-settings-portal" data-hookchart-language={chartLanguage} lang={chartLanguage}>
        <OriginalHookChartSettings
          open
          densityCut={liveFeed.densityCut}
          loadedCandles={candles.length}
          historyStatus={historyStatus}
          onRetryHistory={() => setHistoryRetry(previous => previous + 1)}
          prefs={{ ...settings, language: chartLanguage, ...(externalData ? { candleLongColor: externalData.appearance.upColor, candleShortColor: externalData.appearance.downColor, showVolumes: externalData.appearance.volume } : {}) }}
          onChange={changeSettings}
          onApplyStrategy={applyStrategy}
          activeVisualContext={activeVisualContext}
          currentViewport={viewport}
          currentPlotWidth={hookChartPlotWidth(rootRef.current?.clientWidth || 800)}
          onCaptureVisual={captureCurrentVisual}
          onResetVisual={key => { if (key === activeVisualKey) engineRef.current?.zoomToLatest(); }}
          previewCandles={candles}
          previewSymbol={symbol}
          previewTimeframe={timeframe}
          previewExchange={exchange}
          previewMarketType={marketType}
          previewTimezone={timezone}
          previewLongColor={externalData?.appearance.upColor || settings.candleLongColor || '#0ECB81'}
          previewShortColor={externalData?.appearance.downColor || settings.candleShortColor || '#F6465D'}
          onClose={closeSettings}
        />
      </div>,
      document.body,
    )}

    {!replay && panel === 'settings' && <div className="hookchart-options hookchart-options-compat" aria-hidden="true">
      <button type="button" aria-label="Закрити налаштування hookchart" onClick={() => setPanel(null)} />
      {OVERLAYS.map(([id, label]) => <label key={id}>
        <input type="checkbox" checked={overlayEnabled(id)} onChange={() => toggleOverlay(id)} />
        {label}
      </label>)}
    </div>}

    {saveError && <button type="button" className="hookchart-save-error" onClick={flush}>Не вдалося зберегти налаштування. Повторити</button>}
    {oiError && <span className="hookchart-feed-status" role="status">Дані OI тимчасово недоступні</span>}

    <div className="chartStage" data-drawing-tools={drawingToolbarOpen ? 'open' : 'closed'}>
      {chartToolbarEnabled && <button
        type="button"
        className={`drawPanelToggle ${drawingToolbarOpen ? 'open' : ''}`}
        aria-expanded={drawingToolbarOpen}
        title={drawingToolbarOpen ? 'Згорнути панель малювання' : 'Розгорнути панель малювання'}
        aria-label={drawingToolbarOpen ? 'Згорнути панель малювання' : 'Розгорнути панель малювання'}
        onClick={toggleDrawingToolbar}
      >
        {drawingToolbarOpen ? '‹' : '›'}
      </button>}

      {drawingToolbarOpen && <div className="floatingDrawTools" role="toolbar" aria-label="Інструменти hookchart" aria-orientation="vertical">
        {TOOLS.filter(([id]) => !replay || id !== 'alert').map(([id, label, Icon]) => <button
          key={id}
          type="button"
          title={settings.tooltips !== false ? label : undefined}
          aria-label={label}
          aria-pressed={tool === id}
          onClick={() => { setTool(id); setPanel(null); }}
          className={tool === id ? 'active' : ''}
        >
          <Icon size={15} />
        </button>)}
        <button
          type="button"
          title={settings.tooltips !== false ? 'Індикатори' : undefined}
          aria-label="Індикатори"
          aria-expanded={panel === 'indicators'}
          className={panel === 'indicators' ? 'active' : ''}
          onClick={() => { setPanel(panel === 'indicators' ? null : 'indicators'); setTool('cursor'); }}
        >
          <IndicatorIcon />
        </button>
        <div className="floatingDivider" />
        <button
          type="button"
          className="clearChartBtn"
          title={settings.tooltips !== false ? 'Очистити фігури та локальні мітки (Telegram-сповіщення видаляються натисканням на лінію)' : undefined}
          aria-label="Очистити фігури та локальні мітки (Telegram-сповіщення видаляються натисканням на лінію)"
          onClick={() => { setDrawings([]); setAlerts([]); setTool('cursor'); }}
        >
          <Trash2 size={15} />
        </button>
      </div>}

      {drawingToolbarOpen && panel === 'indicators' && <div className="indicatorDrawer" role="group" aria-label="Індикатори">
        <div className="indicatorDrawerHead">
          <b>Індикатори</b>
          <button type="button" aria-label="Закрити індикатори" onClick={() => setPanel(null)}><X size={14} /></button>
        </div>
        <div className="indicatorDrawerList">
          {INDICATOR_META.map(meta => <button
            key={meta.id}
            type="button"
            title={settings.tooltips !== false ? meta.description : undefined}
            aria-label={meta.name}
            aria-pressed={indicators.includes(meta.id)}
            disabled={meta.id === 'oi' && (replay || !!externalData || marketType !== 'futures')}
            className={indicators.includes(meta.id) ? 'on' : ''}
            onClick={() => toggleIndicator(meta.id)}
          >
            <i aria-hidden="true">{meta.short}</i>
            <span>{meta.name}</span>
            <em aria-hidden="true">{indicators.includes(meta.id) ? 'ON' : 'OFF'}</em>
          </button>)}
        </div>
      </div>}

      {tool === 'text' && <label className="hookchart-text-input">
        Текст
        <input aria-label="Текст нотатки" value={textLabel} maxLength={200} onChange={event => setTextLabel(event.target.value)} />
      </label>}

      <Chart
        candles={candles}
        terminalMode={terminalMode}
        terminalAutoScale={terminalAutoScale}
        visualProfile={activeVisualProfile}
        visualProfileKey={replay ? undefined : activeVisualKey}
        focusFormation={focusFormation}
        symbol={symbol}
        tf={timeframe}
        tool={tool}
        drawings={drawings}
        setDrawings={setDrawings}
        alerts={visiblePriceMarkers}
        onCreatePriceAlert={(price) => { if (!replay) void createTelegramPriceAlert(price); }}
        onSelectPriceAlert={setSelectedPriceMarker}
        setAlerts={setAlerts}
        densities={replay ? [] : chartDensities}
        marketPrints={replay ? [] : liveFeed.marketPrints}
        liquidations={replay ? [] : liveFeed.liquidations}
        sessionLiquidationsUsd={liveFeed.sessionLiquidationsUsd}
        showLiquidationLong={settings.showLiquidationLong !== false}
        showLiquidationShort={settings.showLiquidationShort !== false}
        autoLevels={visibleAutoLevels}
        cascadeRisk={liveFeed.cascadeRisk}
        liquidationCut={liveFeed.liquidationCut}
        liquidationSource={liveFeed.liquidationSource}
        liquidationStreamLive={liveFeed.liquidationStreamLive}
        liquidationLastEventAt={liveFeed.liquidationLastEventAt}
        levelLabelMode={settings.levelLabelMode || 'always'}
        levelLabelColor={settings.levelLabelColor || '#2090F0'}
        levelLabelSize={settings.levelLabelSize ?? 11}
        levelLabelStyle={settings.levelLabelStyle || 'text'}
        levelLineStyle={settings.levelLineStyle || 'solid'}
        crosshairLineWidth={settings.crosshairLineWidth}
        rightPaddingBars={rightPaddingBars}
        roundGrid={!!settings.roundGrid}
        roundness={settings.roundness ?? 2}
        markers={markers}
        expandPriceScaleToMarkers={expandPriceScaleToMarkers}
        timeMarkers={externalData?.timeMarkers}
        splitVolumes={!!externalData}
        transientRuler={!!externalData}
        backgroundColor={externalData?.appearance.background}
        gridColor={externalData?.appearance.gridColor}
        controlRef={assignRef}
        initialLogicalRange={savedChartParams?.visibleRange}
        timezone={timezone}
        language={chartLanguage}
        textLabel={textLabel || 'Нотатка'}
        showMarketPrintSums={settings.showMarketPrintSums === true}
        showVolumes={externalData ? externalData.appearance.volume : settings.showVolumes !== false}
        gridHorizontal={!!settings.gridHorizontal}
        gridVertical={!!settings.gridVertical}
        showDensityLines={!replay && !!settings.showDensityLines}
        showDensityLabels={!replay && !!settings.showDensityLabels}
        showDensityAmounts={!replay && !!settings.showDensityAmounts}
        highlightDensityReaction={settings.densityMode !== 'manual'}
        showLiquidations={!replay && settings.showLiquidations !== false}
        showLiqRiskBlock={!replay && !externalData && !terminalMode && settings.showLiqRiskBlock !== false}
        candleLongColor={externalData?.appearance.upColor || settings.candleLongColor || '#0ECB81'}
        candleShortColor={externalData?.appearance.downColor || settings.candleShortColor || '#F6465D'}
        densityLineColor={settings.densityLineColor || '#7B61FF'}
        densityLabelColor={settings.densityLabelColor || '#C4B5FD'}
        densityLineWidth={settings.densityLineWidth ?? .5}
        densityLineStyle={settings.densityLineStyle || 'solid'}
        densityLabelSize={settings.densityLabelSize ?? 8}
        autoSR={replay ? replayOverlays.includes('sr') : !!settings.autoSR}
        showSRLabels={settings.showSRLabels !== false}
        autoPrevDay={replay ? replayOverlays.includes('prevDay') : !!settings.autoPrevDay}
        autoDayOpen={replay ? replayOverlays.includes('dayOpen') : !!settings.autoDayOpen}
        autoVWAP={replay ? replayOverlays.includes('vwap') : !!settings.autoVWAP}
        autoLocalHL={replay ? replayOverlays.includes('localHL') : !!settings.autoLocalHL}
        autoRoundLevels={replay ? replayOverlays.includes('roundLevels') : !!settings.autoRoundLevels}
        autoPOC={replay ? replayOverlays.includes('poc') : !!settings.autoPOC}
        autoStops={replay ? replayOverlays.includes('stops') : !!settings.autoStops}
        autoChannel={replay ? replayOverlays.includes('channel') : !!settings.autoChannel}
        channelModel={channel}
        strategyResult={strategyResult}
        hideTimeJump={terminalMode || replay || drawingToolbarOpen}
        hideBarCountdown={replay}
        controlsContainer={controlsContainer}
        countdownContainer={countdownContainer}
        onNeedHistory={replay ? undefined : needHistory}
        onViewportChange={setViewport}
        onCrosshairChange={crosshair.set}
        onCrosshairPriceChange={onCrosshairPriceChange}
      />
      {selectedPriceMarker && (selectedPriceAlert || selectedLocalMarker) && (
        <div className="hookchart-alert-confirm" role="dialog" aria-label="Видалити цінове сповіщення">
          <strong>{selectedPriceAlert ? 'Telegram-сповіщення' : 'Локальна мітка'}</strong>
          <span>{selectedPriceAlert
            ? `${selectedPriceAlert.symbol} ${selectedPriceAlert.condition === 'gte' ? '≥' : '≤'} ${selectedPriceAlert.targetPrice}`
            : `${symbol} · ${selectedLocalMarker?.p}`}</span>
          {!selectedPriceAlert && <small>Локальна мітка не надсилає повідомлення в Telegram.</small>}
          <div>
            <button type="button" onClick={() => setSelectedPriceMarker(null)} disabled={deletingPriceMarker}>Скасувати</button>
            <button type="button" className="danger" onClick={() => void confirmDeletePriceMarker()} disabled={deletingPriceMarker}>
              {deletingPriceMarker ? 'Видалення…' : 'Видалити'}
            </button>
          </div>
        </div>
      )}
      {alertNotice && (
        <div className={`hookchart-alert-notice ${alertNotice.error ? 'error' : 'success'}`} role="status">
          <span>{alertNotice.text}</span>
          <button type="button" aria-label="Закрити повідомлення" onClick={() => setAlertNotice(null)}>×</button>
        </div>
      )}
      {!candles.length && <span className="hookchart-empty" role="status">Завантаження свічок…</span>}
    </div>

    <IndicatorDock ids={indicators} candles={candles} oi={oi} viewport={viewport} rightPaddingBars={rightPaddingBars} onToggle={toggleIndicator} />
    <ChartTimeAxis candles={candles} tf={timeframe} timezone={timezone} language={chartLanguage} viewport={viewport} rightPaddingBars={rightPaddingBars} countdownRef={setCountdownContainer} crosshair={crosshair} />

    <div className="hookchart-footer">
      {!replay && !externalData && settings.showMarketStatsBar !== false && <div ref={statsBarRef} className="marketStatsBar" role="region" aria-label="Показники ринку" tabIndex={0}>
        <span>Vol 24h: <b>{marketStats.vol24 ? `$${formatUsd(marketStats.vol24)}` : '—'}</b></span>
        <span>Max: <b>{marketStats.high ? marketStats.high.toLocaleString(undefined, { maximumFractionDigits: marketStats.high < 10 ? 4 : 2 }) : '—'}</b></span>
        <span>Min: <b>{marketStats.low ? marketStats.low.toLocaleString(undefined, { maximumFractionDigits: marketStats.low < 10 ? 4 : 2 }) : '—'}</b></span>
        <span title={btcCorrelation
          ? `Кореляція Пірсона логарифмічних дохідностей: ${btcCorrelation.pairs} пар закритих свічок (${timeframe}), ${exchange.toUpperCase()} ${marketType}, до BTC. Шкала −1…+1.`
          : 'Кореляція BTC недоступна: недостатньо однакових закритих свічок або немає відповіді біржі.'}>
          Corr BTC: <b>{btcCorrelation ? btcCorrelation.value.toFixed(2) : '—'}</b>
        </span>
        <span>Vol: <b>{Number.isFinite(marketStats.natr) ? `${marketStats.natr.toFixed(2)}%` : '—'}</b></span>
        {exchange === 'binance' && <span title="Справжня кількість угод за останні 24 години за даними Binance 24h ticker. Якщо даних немає, показано —.">
          Trades 24h: <b>{tradeCount24h?.scope === statsScope && tradeCount24h.count !== null
            ? tradeCount24h.count.toLocaleString() : '—'}</b>
        </span>}
      </div>}
      <div className="hookchart-footer-controls" ref={setControlsContainer} />
      {footerActions && <div className="hookchart-footer-actions">{footerActions}</div>}
    </div>
  </div>;
});

export default HookChartCanvas;
