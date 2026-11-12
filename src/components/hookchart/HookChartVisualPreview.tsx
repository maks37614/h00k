import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ExchangeId, MarketType } from '../../types';
import type { Candle } from './engine';
import type { VisualChartProfile, VisualContextId, VisualDevice } from './visualProfiles';
import {
  DEMO_WIDTH, DEMO_HEIGHT, DEMO_PLOT_LEFT, DEMO_PLOT_WIDTH,
  DEMO_PLOT_TOP, DEMO_CANDLE_BOTTOM, demoDragProfile, demoPinchProfile,
  demoWheelProfile, demoZoomBars, syntheticBar,
} from './syntheticPreviewModel';

interface HookChartVisualPreviewProps {
  /** Kept for caller compatibility. The demo deliberately ignores real market data. */
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
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

export function profilePreviewWidth(context: VisualContextId, device: VisualDevice): number {
  if (device === 'mobile') return 354;
  if (context === 'terminalCompact') return 370;
  if (context === 'terminalMedium') return 570;
  if (context === 'screenerQuick' || context === 'formationsQuick') return 550;
  return 760;
}

type Point = { x: number; y: number };
type DragStart = { point: Point; profile: VisualChartProfile };
type PinchStart = { horizontal: number; vertical: number; profile: VisualChartProfile };

/**
 * Lightweight synthetic candlestick editor. Every gesture immediately edits
 * the exact profile object rendered by the settings sliders and saved by the
 * parent. No live HookChart engine, exchange requests, or extra timers.
 */
export function HookChartVisualPreview({
  visualContext, visualDevice, profile, onChange, saveStatus = 'idle',
  longColor = '#0ECB81', shortColor = '#F6465D',
}: HookChartVisualPreviewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const profileRef = useRef(profile);
  const changeRef = useRef(onChange);
  profileRef.current = profile;
  changeRef.current = onChange;
  const pointers = useRef(new Map<number, Point>());
  const dragStart = useRef<DragStart | null>(null);
  const pinchStart = useRef<PinchStart | null>(null);
  const [edited, setEdited] = useState(false);
  const [saveRequested, setSaveRequested] = useState(false);
  const clipId = useId();

  useEffect(() => {
    pointers.current.clear();
    dragStart.current = null;
    pinchStart.current = null;
    setEdited(false);
    setSaveRequested(false);
  }, [visualContext, visualDevice]);

  const apply = (next: VisualChartProfile) => {
    const current = profileRef.current;
    if (current.visibleBars === next.visibleBars
      && current.verticalZoom === next.verticalZoom
      && current.rightGapBars === next.rightGapBars
      && current.autoPriceScale === next.autoPriceScale) return;
    // Keep gestures cumulative even when React renders are batched.
    profileRef.current = next;
    setEdited(true);
    changeRef.current(next);
  };

  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    // Native non-passive wheel listener prevents page scrolling only while the
    // cursor is over this interactive chart.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const next = demoWheelProfile(profileRef.current, event.deltaY);
      if (next.visibleBars !== profileRef.current.visibleBars) {
        profileRef.current = next;
        setEdited(true);
        changeRef.current(next);
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const pointerPoint = (event: React.PointerEvent<SVGSVGElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * DEMO_WIDTH / Math.max(1, rect.width),
      y: (event.clientY - rect.top) * DEMO_HEIGHT / Math.max(1, rect.height),
    };
  };

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    pinchStart.current = {
      horizontal: Math.abs(a.x - b.x),
      vertical: Math.abs(a.y - b.y),
      profile: profileRef.current,
    };
    dragStart.current = null;
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPoint(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 1) {
      dragStart.current = { point, profile: profileRef.current };
    } else if (pointers.current.size === 2) startPinch();
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = pointerPoint(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      apply(demoPinchProfile(
        pinchStart.current.profile,
        pinchStart.current.horizontal, Math.abs(a.x - b.x),
        pinchStart.current.vertical, Math.abs(a.y - b.y),
      ));
      return;
    }
    const initial = dragStart.current;
    if (pointers.current.size === 1 && initial) {
      apply(demoDragProfile(initial.profile, point.x - initial.point.x, point.y - initial.point.y));
    }
  };

  const onPointerEnd = (event: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pinchStart.current = null;
    const single = [...pointers.current.values()][0];
    dragStart.current = single ? { point: single, profile: profileRef.current } : null;
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    const p = profileRef.current;
    let next: VisualChartProfile | null = null;
    switch (event.key) {
      case 'ArrowLeft': next = demoDragProfile(p, -12, 0); break;
      case 'ArrowRight': next = demoDragProfile(p, 12, 0); break;
      case 'ArrowUp': next = demoDragProfile(p, 0, -12); break;
      case 'ArrowDown': next = demoDragProfile(p, 0, 12); break;
      case '+': case '=': next = demoZoomBars(p, .85); break;
      case '-': next = demoZoomBars(p, 1.15); break;
      default: break;
    }
    if (next) { event.preventDefault(); apply(next); }
  };

  const samples = useMemo(() => {
    const number = Math.min(155, Math.max(15, profile.visibleBars));
    return Array.from({ length: number }, (_, i) => {
      const barIndex = Math.round(i * (profile.visibleBars - 1) / Math.max(1, number - 1));
      return { index: barIndex, ...syntheticBar(barIndex + 22) };
    });
  }, [profile.visibleBars]);
  const limits = useMemo(() => {
    const lows = samples.map(row => row.low);
    const highs = samples.map(row => row.high);
    const low = Math.min(...lows);
    const high = Math.max(...highs);
    const center = profile.autoPriceScale ? (high + low) / 2 : 105;
    const naturalRange = profile.autoPriceScale ? Math.max(8, high - low) * 1.32 : 40;
    const span = naturalRange / Math.max(.01, profile.verticalZoom);
    return { center, span };
  }, [samples, profile.autoPriceScale, profile.verticalZoom]);

  const priceY = (price: number) =>
    DEMO_CANDLE_BOTTOM - (price - (limits.center - limits.span / 2))
      / limits.span * (DEMO_CANDLE_BOTTOM - DEMO_PLOT_TOP);
  const step = DEMO_PLOT_WIDTH / Math.max(1, profile.visibleBars + profile.rightGapBars);
  const barSize = Math.min(9, Math.max(.7, step * .67));
  const lastBarX = DEMO_PLOT_LEFT + profile.visibleBars * step;

  return (
    <div className="hookchart-visual-preview">
      <div className="hookchart-visual-preview-caption">
        <strong>DEMO · OHLCV</strong>
        <span>{visualDevice === 'mobile' ? 'Телефон' : 'Комп’ютер'}</span>
        <span className="hookchart-visual-preview-live">Штучні дані · без підключення до біржі</span>
      </div>

      <div className="hookchart-visual-preview-frame"
        style={{ maxWidth: profilePreviewWidth(visualContext, visualDevice) }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${DEMO_WIDTH} ${DEMO_HEIGHT}`}
          className="hookchart-synthetic-preview"
          role="application"
          tabIndex={0}
          aria-label="Демонстраційний свічковий графік. Перетягування вліво чи вправо змінює відступ, вгору чи вниз — вертикальний зум. Колесо миші або рух двох пальців змінює кількість свічок."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={DEMO_PLOT_LEFT} y={DEMO_PLOT_TOP}
                width={DEMO_PLOT_WIDTH} height={DEMO_CANDLE_BOTTOM - DEMO_PLOT_TOP}/>
            </clipPath>
          </defs>
          <rect width={DEMO_WIDTH} height={DEMO_HEIGHT} fill="#111925"/>
          {Array.from({ length: 5 }, (_, i) => {
            const y = DEMO_PLOT_TOP + i * (DEMO_CANDLE_BOTTOM - DEMO_PLOT_TOP) / 4;
            return <g key={'grid' + i}>
              <line x1={DEMO_PLOT_LEFT} x2={DEMO_PLOT_LEFT + DEMO_PLOT_WIDTH}
                y1={y} y2={y} stroke="#283346" strokeWidth=".8"/>
              <text x={DEMO_PLOT_LEFT + DEMO_PLOT_WIDTH + 6} y={y + 4}
                fill="#91a4bb" fontSize="11">{(limits.center + limits.span * (.5 - i / 4)).toFixed(2)}</text>
            </g>;
          })}
          {Array.from({ length: 6 }, (_, i) =>
            <line key={'vert' + i}
              x1={DEMO_PLOT_LEFT + DEMO_PLOT_WIDTH * i / 5}
              x2={DEMO_PLOT_LEFT + DEMO_PLOT_WIDTH * i / 5}
              y1={DEMO_PLOT_TOP} y2="229" stroke="#253044" strokeWidth=".7"/>)}
          <rect x={DEMO_PLOT_LEFT} y="185" width={DEMO_PLOT_WIDTH}
            height="47" fill="#0d1420" opacity=".85"/>
          <line x1={DEMO_PLOT_LEFT} y1="184" x2={DEMO_PLOT_LEFT + DEMO_PLOT_WIDTH}
            y2="184" stroke="#304159" strokeWidth="1"/>
          <g clipPath={`url(#${clipId})`}>
            {samples.map((row, i) => {
              const x = DEMO_PLOT_LEFT + (row.index + .5) * step;
              const upper = Math.min(priceY(row.open), priceY(row.close));
              const lower = Math.max(priceY(row.open), priceY(row.close));
              const color = row.close >= row.open ? longColor : shortColor;
              return <g key={'candle' + i}>
                <line x1={x} x2={x} y1={priceY(row.high)} y2={priceY(row.low)}
                  stroke={color} strokeWidth={Math.max(.7, Math.min(1.4, barSize / 3))}/>
                <rect x={x - barSize / 2} y={upper} width={barSize}
                  height={Math.max(.9, lower - upper)} fill={color}/>
              </g>;
            })}
          </g>
          <g>
            {samples.map((row, i) => {
              const x = DEMO_PLOT_LEFT + (row.index + .5) * step;
              return <rect key={'volume' + i} x={x - barSize / 2}
                y={230 - row.volume * .8} width={barSize}
                height={row.volume * .8}
                fill={row.close >= row.open ? longColor : shortColor} opacity=".42"/>;
            })}
          </g>
          <line x1={DEMO_PLOT_LEFT + DEMO_PLOT_WIDTH} y1="0"
            x2={DEMO_PLOT_LEFT + DEMO_PLOT_WIDTH} y2={DEMO_HEIGHT}
            stroke="#43526a" strokeWidth="1.3"/>
          <rect x={Math.min(lastBarX, DEMO_PLOT_LEFT + DEMO_PLOT_WIDTH)}
            y="236" width={Math.max(0, DEMO_PLOT_LEFT + DEMO_PLOT_WIDTH - lastBarX)} height="10"
            fill="#1a7299" opacity=".35"/>
          <text x="22" y="245" fill="#8297ad" fontSize="10">
            {profile.visibleBars} свічок · зум {profile.verticalZoom.toFixed(2)}×
          </text>
          <text x="620" y="245" fill="#72c9ee" fontSize="10" textAnchor="end">
            Відступ: {profile.rightGapBars}
          </text>
        </svg>
      </div>

      <div className="hookchart-visual-preview-actions">
        <span>Тягни свічки ←→ — відступ, ↑↓ — зум. Колесо миші / два пальці — кількість свічок.</span>
        <div className="hookchart-demo-controls">
          <button type="button" onClick={() => apply(demoZoomBars(profileRef.current, .8))}
            aria-label="Збільшити свічки по горизонталі">− свічок</button>
          <button type="button" onClick={() => apply(demoZoomBars(profileRef.current, 1.25))}
            aria-label="Зменшити свічки по горизонталі">+ свічок</button>
          <button type="button" onClick={() => apply({
            ...profileRef.current, autoPriceScale: !profileRef.current.autoPriceScale,
          })} aria-pressed={profile.autoPriceScale}>
            Автоціна: {profile.autoPriceScale ? 'увімк.' : 'вимк.'}
          </button>
        </div>
        <button type="button" onClick={() => {
          setSaveRequested(true);
          setEdited(true);
          changeRef.current({ ...profileRef.current });
        }}>Зберегти масштаб із цього графіка</button>
      </div>
      {(edited || saveRequested) && <div role="status" aria-live="polite" className="settingsHint">
        {saveStatus === 'saved' ? 'Масштаб збережено у профілі користувача.'
          : saveStatus === 'error' ? 'Не вдалося зберегти масштаб. Повтори збереження.'
          : saveStatus === 'saving' ? 'Зберігаємо налаштування у профілі…'
          : 'Зміни одразу передані в налаштування під графіком.'}
      </div>}
      <p className="hookchart-visual-preview-info">
        Це легкий демонстраційний графік зі штучними свічками, а не біржові котирування.
        Зміни тут одразу оновлюють повзунки та відповідний профіль HookChart для реальних графіків.
      </p>
    </div>
  );
}
