import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HookChartPreferences } from '../../types';
import { createSyntheticPreviewCandles } from './syntheticPreviewCandles';
import {
  Chart, ChartTimeAxis,
  type Alert, type CascadeRisk, type Drawing, type Viewport, type ViewportGesture, type HookChartHandle,
} from './engine';
import { hookChartPlotWidth } from './priceScale';
import { captureVisualProfile, makeVisualProfileKey, VISUAL_GAP_MAX, type VisualChartProfile, type VisualContextId, type VisualDevice } from './visualProfiles';

const EMPTY_RISK: CascadeRisk = {
  score: 0, level: 'LOW', total5: 0, count5: 0, longUsd: 0, shortUsd: 0,
};
const OFFLINE_CANDLES = createSyntheticPreviewCandles(900);
const EMPTY_DENSITIES: [] = [];
const EMPTY_MARKET_PRINTS: [] = [];
const EMPTY_LIQUIDATIONS: [] = [];
const EMPTY_AUTO_LEVELS: [] = [];

interface HookChartVisualPreviewProps {
  /** All settings are applied only to deterministic offline candles. */
  timezone?: string;
  longColor?: string;
  shortColor?: string;
  chartPreferences?: HookChartPreferences;
  visualContext: VisualContextId;
  visualDevice: VisualDevice;
  profile: VisualChartProfile;
  onChange: (profile: VisualChartProfile) => void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

/**
 * Offline illustration rendered by the SAME HookChart viewport/price-scale engine.
 * No parent candles, REST polling, exchange requests or WebSocket subscriptions.
 * Only this small canvas is mounted while the Graph-settings tab is visible.
 */
export function HookChartVisualPreview({
  timezone = 'Europe/Warsaw',
  longColor = '#0ECB81',
  shortColor = '#F6465D',
  chartPreferences,
  visualContext,
  visualDevice,
  profile,
  onChange,
  saveStatus = 'idle',
}: HookChartVisualPreviewProps) {
  const [chartWidth, setChartWidth] = useState(0);
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

  // Module-level deterministic data. No network call, per-candle subscription,
  // interval or computation of live market indicators can be initiated here.
  const activeCandles = OFFLINE_CANDLES;
  const activeSymbol = 'DEMO';
  const activeTimeframe = '15m';
  useEffect(() => {
    const root = previewRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const update = () => setChartWidth(Math.max(0, Math.round(root.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

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
    <div className="hookchart-visual-preview" data-synthetic-hookchart="true">
      <div className="hookchart-visual-preview-caption">
        <strong>DEMO</strong>
        <span>15m</span>
        <span>Штучні свічки</span>
        <span className="hookchart-visual-preview-live">Без біржових запитів</span>
      </div>
      <>
          <div className="hookchart-visual-preview-frame">
            <div ref={previewRef} className="hookchart-visual-preview-chart"
              onPointerDownCapture={rememberDragStart}
              onWheelCapture={rememberDragStart}>
              <Chart
                key="offline-demo-15m"
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
                showVolumes={chartPreferences?.showVolumes !== false}
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
          <div className="hookchart-live-metrics" role="status">
            <span>Ширина: <b>{chartWidth || '—'} px</b></span>
            <span>Видимі свічки: <b>{measuredSlots ?? '—'}</b></span>
            <span>Відступ: <b>{profile.rightGapBars} барів</b></span>
            <span>Вертикальний масштаб: <b>{profile.verticalZoom}×</b></span>
          </div>
          <div className="hookchart-visual-preview-actions">
            <span>Рухай і масштабуй штучний графік пальцем або мишею. Масштаб і відступ зберігаються у відповідному профілі.</span>
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
      {typeof window !== 'undefined' && visualDevice !== (window.innerWidth < 768 ? 'mobile' : 'desktop') && (
        <p className="hookchart-device-notice">
          Обрано профіль «{visualDevice === 'desktop' ? 'Комп’ютер' : 'Телефон'}», але редактор відкрито
          на іншому пристрої. Для піксельної відповідності відкрий його на відповідному екрані.
        </p>
      )}
      <p className="hookchart-visual-preview-info">
        Штучні свічки (не ринкові дані) відображає той самий рушій HookChart, який розраховує
        масштаб, правий відступ і шкалу цін на сайті. Жодних запитів до бірж чи окремих WebSocket.
        Результат зберігається для вибраного типу графіка та пристрою. На інших розмірах
        екрана геометрія масштабу перераховується за реальною шириною області графіка.
      </p>
    </div>
  );
}
