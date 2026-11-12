import { VISUAL_GAP_MAX, VISUAL_ZOOM_MAX, VISUAL_ZOOM_MIN, type VisualChartProfile } from './visualProfiles';

export const DEMO_WIDTH = 640;
export const DEMO_HEIGHT = 252;
export const DEMO_PLOT_LEFT = 16;
export const DEMO_PLOT_WIDTH = 544;
export const DEMO_PLOT_TOP = 18;
export const DEMO_CANDLE_BOTTOM = 178;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function adjusted(profile: VisualChartProfile, delta: Partial<VisualChartProfile>): VisualChartProfile {
  return {
    ...profile,
    ...delta,
    visibleBars: Math.round(clamp(delta.visibleBars ?? profile.visibleBars, 15, 500)),
    rightGapBars: Math.round(clamp(delta.rightGapBars ?? profile.rightGapBars, 0, VISUAL_GAP_MAX)),
    verticalZoom: Math.round(clamp(delta.verticalZoom ?? profile.verticalZoom, VISUAL_ZOOM_MIN, VISUAL_ZOOM_MAX) * 1000) / 1000,
  };
}

/** Dragging candles left/right sets the same right-gap value used by real HookCharts.
 * Dragging up/down directly changes the profile's vertical zoom. */
export function demoDragProfile(
  start: VisualChartProfile, dx: number, dy: number,
): VisualChartProfile {
  const pixelsPerBar = DEMO_PLOT_WIDTH / (start.visibleBars + start.rightGapBars);
  return adjusted(start, {
    rightGapBars: start.rightGapBars - dx / Math.max(.15, pixelsPerBar),
    verticalZoom: start.verticalZoom * Math.exp(-dy / 115),
  });
}

/** Two-finger horizontal pinch controls visible candle count; vertical pinch controls price zoom. */
export function demoPinchProfile(
  start: VisualChartProfile,
  initialHorizontal: number, currentHorizontal: number,
  initialVertical: number, currentVertical: number,
): VisualChartProfile {
  return adjusted(start, {
    visibleBars: initialHorizontal >= 18
      ? start.visibleBars * clamp(initialHorizontal / Math.max(8, currentHorizontal), .05, 20)
      : start.visibleBars,
    verticalZoom: initialVertical >= 18
      ? start.verticalZoom * clamp(currentVertical / Math.max(8, initialVertical), .05, 20)
      : start.verticalZoom,
  });
}

export function demoWheelProfile(profile: VisualChartProfile, deltaY: number): VisualChartProfile {
  return adjusted(profile, { visibleBars: profile.visibleBars * Math.exp(clamp(deltaY, -1000, 1000) * .0017) });
}

export function demoZoomBars(profile: VisualChartProfile, factor: number): VisualChartProfile {
  return adjusted(profile, { visibleBars: profile.visibleBars * factor });
}

/** Fixed procedural OHLCV samples; this preview never contacts an exchange. */
export function syntheticBar(index: number) {
  const trend = 103 + Math.sin(index * .065) * 8 + Math.sin(index * .019) * 10 + Math.sin(index * .24) * 2;
  const open = trend + Math.sin(index * .63) * 1.8;
  const close = trend + Math.sin(index * .71 + 1.3) * 2.3;
  const high = Math.max(open, close) + 1.2 + (index % 5) * .24;
  const low = Math.min(open, close) - 1.1 - (index % 7) * .19;
  const volume = 8 + (index * 13 % 23) + Math.abs(close - open) * 2;
  return { open, close, high, low, volume };
}
