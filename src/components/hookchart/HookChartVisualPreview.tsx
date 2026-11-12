import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExchangeId, MarketType, Timeframe } from '../../types';
import { fetchDirectKlines } from '../../utils/directExchangeClient';
import { toHookCandles } from '../../utils/hookchartData';
import {
  Chart, ChartTimeAxis,
  type Alert, type Candle, type CascadeRisk, type Drawing, type Viewport,
} from './engine';
import { hookChartPlotWidth } from './priceScale';
import { captureVisualProfile, makeVisualProfileKey, type VisualChartProfile, type VisualContextId, type VisualDevice } from './visualProfiles';

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
  visualContext: VisualContextId;
  visualDevice: VisualDevice;
  profile: VisualChartProfile;
  onChange: (profile: VisualChartProfile) => void;
}

function profilePreviewWidth(context: VisualContextId, device: VisualDevice): number {
  if (device === 'mobile') return 354;
  if (context === 'terminalCompact') return 370;
  if (context === 'terminalMedium') return 570;
  if (context === 'screenerQuick' || context === 'formationsQuick') return 550;
  return 760;
}

/**
 * Identical HookChart canvas engine to the live graph. It is mounted only when
 * the Graph tab is active and uses existing candles. In the account editor,
 * where there is no selected market, load real BTCUSDT spot candles once and
 * never start an exchange websocket or polling loop.
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
  visualContext,
  visualDevice,
  profile,
  onChange,
}: HookChartVisualPreviewProps) {
  const [sample, setSample] = useState<Candle[]>(EMPTY_CANDLES);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({
    barWidth: 9, rightOffset: 0, autoY: true,
    manualCenter: null, manualRange: null, fitAll: false,
  });
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const previewRef = useRef<HTMLDivElement>(null);
  const useParentCandles = (candles?.length ?? 0) > 0;

  useEffect(() => {
    if (useParentCandles) return;
    let active = true;
    setSampleLoading(true);
    setSampleError(false);
    void fetchDirectKlines('binance', 'spot', 'BTCUSDT', '1h', 700)
      .then(rows => {
        if (!active) return;
        const converted = toHookCandles(rows);
        setSample(converted);
        setSampleError(converted.length === 0);
      })
      .catch(() => { if (active) setSampleError(true); })
      .finally(() => { if (active) setSampleLoading(false); });
    return () => { active = false; };
  }, [useParentCandles]);

  const activeCandles = useMemo(
    () => (useParentCandles ? candles! : sample).slice(-700),
    [useParentCandles, candles, sample],
  );
  const activeSymbol = useParentCandles ? (symbol || '—') : 'BTCUSDT';
  const activeTimeframe = useParentCandles ? (timeframe || '1h') : '1h';
  const marketDescription = useParentCandles
    ? `${exchange === 'bybit' ? 'Bybit' : 'Binance'} · ${marketType === 'spot' ? 'Spot' : 'Futures'}`
    : 'Binance · Spot';
  const previewKey = makeVisualProfileKey(visualContext, visualDevice);

  const saveChartScale = useCallback(() => {
    const plotWidth = hookChartPlotWidth(previewRef.current?.getBoundingClientRect().width || 500);
    if (!activeCandles.length) return;
    const count = Math.max(1, Math.ceil(plotWidth / Math.max(.12, viewport.barWidth)));
    const end = Math.min(activeCandles.length, Math.max(0, activeCandles.length - Math.round(viewport.rightOffset)));
    const visible = activeCandles.slice(Math.max(0, end - count), end);
    let lo = Infinity, hi = -Infinity;
    for (const candle of visible) { lo = Math.min(lo, candle.l); hi = Math.max(hi, candle.h); }
    const naturalRange = Number.isFinite(lo) && Number.isFinite(hi)
      ? Math.max(hi - lo, Math.abs(hi) * .01, 1e-10) * (visualContext.startsWith('terminal') ? 1.32 : 1.16)
      : undefined;
    onChange(captureVisualProfile(profile, plotWidth, viewport, naturalRange));
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
            <div ref={previewRef} className="hookchart-visual-preview-chart">
              <Chart
                key={`${activeSymbol}:${activeTimeframe}`}
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
                visualProfileKey={previewKey}
                terminalMode={visualContext.startsWith('terminal')}
                onViewportChange={setViewport}
              />
            </div>
            <ChartTimeAxis
              candles={activeCandles}
              tf={activeTimeframe}
              timezone={timezone}
              viewport={viewport}
              rightPaddingBars={0}
            />
          </div>
          <div className="hookchart-visual-preview-actions">
            <span>Масштабуй свічки мишею або двома пальцями та збережи вигляд.</span>
            <button type="button" onClick={saveChartScale}>Зберегти масштаб із цього графіка</button>
          </div>
        </>
      ) : (
        <div className="hookchart-visual-preview-empty" role="status">
          {sampleLoading
            ? 'Завантажуємо реальні свічки BTCUSDT…'
            : sampleError
              ? 'Немає доступу до котирувань BTCUSDT. Відкрий графік монети на Скрінері, Формаціях або в Терміналі.'
              : 'Очікування свічок для графіка…'}
        </div>
      )}
      <p className="hookchart-visual-preview-info">
        Це справжній HookChart із реальними біржовими свічками. Редактор не створює окремих WebSocket-з’єднань.
        Повзунки застосовуються до попереднього перегляду одразу.
      </p>
    </div>
  );
}
