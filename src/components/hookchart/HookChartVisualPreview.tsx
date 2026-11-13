import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExchangeId, MarketType, Timeframe, HookChartPreferences } from '../../types';
import { fetchDirectKlines } from '../../utils/directExchangeClient';
import { toHookCandles } from '../../utils/hookchartData';
import {
  Chart, ChartTimeAxis,
  type Alert, type Candle, type CascadeRisk, type Drawing, type Viewport, type ViewportGesture, type HookChartHandle,
} from './engine';
import { hookChartPlotWidth } from './priceScale';
import { captureVisualProfile, makeVisualProfileKey, VISUAL_GAP_MAX, type VisualChartProfile, type VisualContextId, type VisualDevice } from './visualProfiles';

const EMPTY_RISK: CascadeRisk = {
  score: 0, level: 'LOW', total5: 0, count5: 0, longUsd: 0, shortUsd: 0,
};
const EMPTY_CANDLES: Candle[] = [];
const EMPTY_DENSITIES: [] = [];
const EMPTY_MARKET_PRINTS: [] = [];
const EMPTY_LIQUIDATIONS: [] = [];
const EMPTY_AUTO_LEVELS: [] = [];

interface HookChartVisualPreviewProps {
  /** Reuse the parent HookChart OHLCV; absolutely no second market feed or socket. */
  candles?: Candle[];
  symbol?: string;
  timeframe?: string;
  exchange?: ExchangeId;
  marketType?: MarketType;
  timezone?: string;
  longColor?: string;
  shortColor?: string;
  marketDefaults?: { exchange?: ExchangeId; marketType?: MarketType; timeframe?: Timeframe };
  chartPreferences?: HookChartPreferences;
  visualContext: VisualContextId;
  visualDevice: VisualDevice;
  profile: VisualChartProfile;
  onChange: (profile: VisualChartProfile) => void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

/**
 * Actual HookChart canvas engine used by live graphs, not an illustrative mock.
 * Standalone profile editor fetches OHLCV only for the explicitly selected
 * symbol/exchange/market/timeframe. No extra WebSockets or polling loops.
 */
export function HookChartVisualPreview({
  candles,
  symbol,
  timeframe,
  exchange,
  marketType,
  timezone = 'Europe/Warsaw',
  longColor = '#0ECB81',
  shortColor = '#F6465D',
  marketDefaults,
  chartPreferences,
  visualContext,
  visualDevice,
  profile,
  onChange,
  saveStatus = 'idle',
}: HookChartVisualPreviewProps) {
  const [marketSymbolDraft, setMarketSymbolDraft] = useState('BTCUSDT');
  const [marketSymbol, setMarketSymbol] = useState('BTCUSDT');
  const [marketExchange, setMarketExchange] = useState<ExchangeId>(marketDefaults?.exchange || 'binance');
  const [marketTypeSelected, setMarketTypeSelected] = useState<MarketType>(marketDefaults?.marketType || 'futures');
  const [marketTimeframe, setMarketTimeframe] = useState<Timeframe>(marketDefaults?.timeframe || '15m');
  const [requestVersion, setRequestVersion] = useState(0);
  const [sample, setSample] = useState<{ scope: string; rows: Candle[] }>({ scope: '', rows: EMPTY_CANDLES });
  const [chartWidth, setChartWidth] = useState(0);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState(false);
  const [visualProfileCaptureVersion, setVisualProfileCaptureVersion] = useState(0);
  const [saveRequested, setSaveRequested] = useState(false);
  const [gestureEdited, setGestureEdited] = useState(false);
  const chartControl = useRef<HookChartHandle | null>(null);
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const viewportRef = useRef<Viewport | null>(null);
  const dragBaseline = useRef<{ gap: number; offset: number } | null>(null);
  const [viewport, setViewport] = useState<Viewport>({
    barWidth: 9, rightOffset: 0, autoY: true,
    manualCenter: null, manualRange: null, fitAll: false,
  });
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const previewRef = useRef<HTMLDivElement>(null);
  // An attached live chart may still be waiting for its first candle. In that
  // case don't make a redundant REST call just to fill the preview.
  const useParentCandles = candles !== undefined;
  const sampleScope = [marketExchange, marketTypeSelected, marketSymbol, marketTimeframe].join(':');
  const applySymbol = () => {
    const cleaned = marketSymbolDraft.trim().toUpperCase().replace(/[\s/-]/g, '');
    if (!/^[A-Z0-9]{2,25}(USDT|USDC|BTC|ETH)$/.test(cleaned)) {
      setSampleError(true);
      return;
    }
    setSampleError(false);
    setMarketSymbol(cleaned);
    setMarketSymbolDraft(cleaned);
  };

  useEffect(() => {
    if (useParentCandles) return;
    let active = true;
    setSampleLoading(true);
    setSampleError(false);
    // Fetch only on explicit market selection, never on slider or zoom updates.
    void fetchDirectKlines(marketExchange, marketTypeSelected, marketSymbol, marketTimeframe, 900)
      .then(rows => {
        if (!active) return;
        const converted = toHookCandles(rows);
        setSample({ scope: sampleScope, rows: converted });
        setSampleError(converted.length === 0);
      })
      .catch(() => { if (active) setSampleError(true); })
      .finally(() => { if (active) setSampleLoading(false); });
    return () => { active = false; };
  }, [useParentCandles, sampleScope, requestVersion, marketExchange, marketTypeSelected, marketSymbol, marketTimeframe]);
  
  // Measure the rendered canvas instead of simulating a fixed 354/550/760px chart.
  useEffect(() => {
    const root = previewRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const update = () => setChartWidth(Math.max(0, Math.round(root.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, [useParentCandles, sampleScope, sample.scope]);

  const activeCandles = useMemo(
    () => (useParentCandles ? candles! : sample.scope === sampleScope ? sample.rows : EMPTY_CANDLES).slice(-900),
    [useParentCandles, candles, sample, sampleScope],
  );
  const activeSymbol = useParentCandles ? (symbol || '—') : marketSymbol;
  const activeTimeframe = useParentCandles ? (timeframe || '15m') : marketTimeframe;
  const selectedExchange = useParentCandles ? (exchange || 'binance') : marketExchange;
  const selectedMarket = useParentCandles ? (marketType || 'futures') : marketTypeSelected;
  const marketDescription = `${selectedExchange === 'bybit' ? 'Bybit' : 'Binance'} · ${selectedMarket === 'spot' ? 'Spot' : 'Futures'}`;
  const measuredSlots = chartWidth > 0 && viewport.barWidth > 0
    ? Math.max(0, Math.round(hookChartPlotWidth(chartWidth) / viewport.barWidth - profile.rightGapBars))
    : null;
  const previewKey = makeVisualProfileKey(visualContext, visualDevice);
  useEffect(() => {
    setSaveRequested(false);
    setGestureEdited(false);
    dragBaseline.current = null;
  }, [visualContext, visualDevice]);

  // The same profile object is used by both this live chart and the controls
  // below it. Only real user gestures update the profile; programmatic slider
  // changes and chart initialization must never feed back into the controls.
  const onGesture = useCallback((nextViewport: Viewport, kind: ViewportGesture) => {
    const current = profileRef.current;
    const plotWidth = hookChartPlotWidth(previewRef.current?.getBoundingClientRect().width || 500);
    if (!activeCandles.length || plotWidth <= 0) return;
    const count = Math.max(1, Math.ceil(plotWidth / Math.max(.12, nextViewport.barWidth) - current.rightGapBars));
    const end = Math.min(activeCandles.length, Math.max(0,
      activeCandles.length - Math.round(nextViewport.rightOffset)));
    const visible = activeCandles.slice(Math.max(0, end - count), end);
    let lo = Infinity, hi = -Infinity;
    for (const candle of visible) { lo = Math.min(lo, candle.l); hi = Math.max(hi, candle.h); }
    const naturalRange = Number.isFinite(lo) && Number.isFinite(hi)
      ? Math.max(hi - lo, Math.abs(hi) * .01, 1e-10) * (visualContext.startsWith('terminal') ? 1.32 : 1.16)
      : undefined;
    const captured = captureVisualProfile(current, plotWidth, nextViewport, naturalRange);
    let next: VisualChartProfile;
    if (kind === 'pan') {
      const baseline = dragBaseline.current ?? {
        gap: current.rightGapBars, offset: viewportRef.current?.rightOffset ?? 0,
      };
      // HookChart compensates its transient viewport offset as the saved
      // right-gap changes during a single drag. Subtract that compensation
      // before measuring the total movement from the pointer-down baseline.
      const compensatedOffset = nextViewport.rightOffset - (current.rightGapBars - baseline.gap);
      const gap = Math.max(0, Math.min(VISUAL_GAP_MAX,
        Math.round(baseline.gap - (compensatedOffset - baseline.offset))));
      next = { ...current, rightGapBars: gap, autoPriceScale: nextViewport.autoY };
      if (!nextViewport.autoY && nextViewport.manualRange) {
        next.verticalZoom = captured.verticalZoom;
      }
    } else if (kind === 'zoom') {
      next = { ...current, visibleBars: captured.visibleBars };
    } else if (kind === 'price') {
      next = { ...current, verticalZoom: captured.verticalZoom, autoPriceScale: captured.autoPriceScale };
    } else {
      next = { ...captured, rightGapBars: current.rightGapBars };
    }
    viewportRef.current = nextViewport;
    if (Object.keys(next).every(k =>
      next[k as keyof VisualChartProfile] === current[k as keyof VisualChartProfile])) return;
    profileRef.current = next;
    setGestureEdited(true);
    // Skip applying the saved profile back over the active drag. HookChart will
    // rebase the viewport offset when the configured right-side gap changes.
    setVisualProfileCaptureVersion(version => version + 1);
    onChange(next);
  }, [activeCandles, visualContext, onChange]);

  const rememberDragStart = useCallback(() => {
    dragBaseline.current = {
      gap: profileRef.current.rightGapBars,
      offset: viewportRef.current?.rightOffset ?? 0,
    };
  }, []);

  const focusLatest = () => {
    chartControl.current?.focusLatest();
    onChange({ ...profileRef.current, autoPriceScale: true });
  };

  const saveChartScale = useCallback(() => {
    const plotWidth = hookChartPlotWidth(previewRef.current?.getBoundingClientRect().width || 500);
    if (!activeCandles.length) return;
    // Only actual candle slots count; free space on the right is not history.
    const count = Math.max(1, Math.ceil(plotWidth / Math.max(.12, viewport.barWidth) - profile.rightGapBars));
    const end = Math.min(activeCandles.length, Math.max(0, activeCandles.length - Math.round(viewport.rightOffset)));
    const visible = activeCandles.slice(Math.max(0, end - count), end);
    let lo = Infinity, hi = -Infinity;
    for (const candle of visible) { lo = Math.min(lo, candle.l); hi = Math.max(hi, candle.h); }
    const naturalRange = Number.isFinite(lo) && Number.isFinite(hi)
      ? Math.max(hi - lo, Math.abs(hi) * .01, 1e-10) * (visualContext.startsWith('terminal') ? 1.32 : 1.16)
      : undefined;
    const captured = captureVisualProfile(profile, plotWidth, viewport, naturalRange);
    // Save the actual gesture-adjusted viewport without forcing this preview
    // to jump back to the profile's reconstructed initial position.
    setSaveRequested(true);
    onChange(captured);
    setVisualProfileCaptureVersion(version => version + 1);
  }, [activeCandles, viewport, profile, visualContext, onChange]);

  return (
    <div className="hookchart-visual-preview">
      <div className="hookchart-visual-preview-caption">
        <strong>{activeSymbol}</strong>
        <span>{activeTimeframe}</span>
        <span>{marketDescription}</span>
        <span className="hookchart-visual-preview-live">
          {useParentCandles ? 'Свічки відкритого графіка' : 'Реальні свічки для прикладу'}
        </span>
      </div>
      {activeCandles.length ? (
        <>
          <div
            className="hookchart-visual-preview-frame"
            style={{ maxWidth: profilePreviewWidth(visualContext, visualDevice) }}
          >
            <div ref={previewRef} className="hookchart-visual-preview-chart"
              onPointerDownCapture={rememberDragStart}
              onWheelCapture={rememberDragStart}>
              <Chart
                key={`${activeSymbol}:${activeTimeframe}`}
                controlRef={chartControl}
                candles={activeCandles}
                symbol={activeSymbol}
                tf={activeTimeframe}
                tool="cursor"
                drawings={drawings}
                setDrawings={setDrawings}
                alerts={alerts}
                setAlerts={setAlerts}
                densities={EMPTY_DENSITIES}
                marketPrints={EMPTY_MARKET_PRINTS}
                liquidations={EMPTY_LIQUIDATIONS}
                autoLevels={EMPTY_AUTO_LEVELS}
                cascadeRisk={EMPTY_RISK}
                levelLabelMode="off"
                showLiqRiskBlock={false}
                showLiquidations={false}
                hideTimeJump
                hideBarCountdown
                controlsContainer={null}
                timezone={timezone}
                candleLongColor={longColor}
                candleShortColor={shortColor}
                visualProfile={profile}
                rightPaddingBars={profile.rightGapBars}
                visualProfileKey={previewKey}
                visualProfileCaptureVersion={visualProfileCaptureVersion}
                terminalMode={visualContext.startsWith('terminal')}
                onViewportChange={next => { viewportRef.current = next; setViewport(next); }}
                onViewportGesture={onGesture}
              />
            </div>
            <ChartTimeAxis
              candles={activeCandles}
              tf={activeTimeframe}
              timezone={timezone}
              viewport={viewport}
              rightPaddingBars={profile.rightGapBars}
            />
          </div>
          <div className="hookchart-visual-preview-actions">
            <span>Переміщуй та масштабуй графік — параметри під ним змінюються одразу.</span>
            <button type="button" onClick={focusLatest}>Автофокус</button>
            <button type="button" onClick={saveChartScale}>Зберегти масштаб</button>
          </div>
          {(saveRequested || gestureEdited) && <div role="status" aria-live="polite" className="settingsHint">
            {saveStatus === 'saved' ? 'Масштаб збережено у профілі користувача.'
              : saveStatus === 'error' ? 'Не вдалося зберегти масштаб. Скористайтеся повторним збереженням.'
              : saveStatus === 'saving' ? 'Зберігаємо масштаб у профілі…'
              : 'Зміни з графіка передані до налаштувань під ним; збереження профілю виконується автоматично.'}
          </div>}
        </>
      ) : (
        <div className="hookchart-visual-preview-empty" role="status">
          {sampleLoading
            ? 'Завантажуємо реальні свічки BTCUSDT…'
            : sampleError
              ? 'Немає доступу до котирувань BTCUSDT. Відкрий графік монети на Скрінері, Формаціях або в Терміналі.'
              : useParentCandles
                ? 'Очікуємо реальні свічки поточної монети…'
                : 'Очікування біржових свічок для графіка…'}
        </div>
      )}
      <p className="hookchart-visual-preview-info">
        Це справжній HookChart із реальними біржовими свічками. Редактор не створює окремих WebSocket-з’єднань.
        Повзунки змінюють графік одразу; рухи та масштабування на графіку оновлюють повзунки і зберігаються в профілі.
      </p>
    </div>
  );
}
