import type { HookChartPreferences } from '../../types';

export const VISUAL_CONTEXTS = [
  { id: 'screenerQuick', label: 'Скрінер · Швидкий перегляд' },
  { id: 'screenerFull', label: 'Скрінер · Повний графік' },
  { id: 'formationsQuick', label: 'Формації · Швидкий перегляд' },
  { id: 'formationsFull', label: 'Формації · Повний графік' },
  { id: 'terminalLarge', label: 'Термінал · Великий графік' },
  { id: 'terminalMedium', label: 'Термінал · Середній графік' },
  { id: 'terminalCompact', label: 'Термінал · Компактний графік' },
] as const;
export type VisualContextId = typeof VISUAL_CONTEXTS[number]['id'];
export type VisualDevice = 'mobile' | 'desktop';
export type VisualProfileKey = \`\${VisualContextId}:\${VisualDevice}\`;

export interface VisualChartProfile {
  visibleBars: number;
  /** Price-axis zoom relative to the automatically calculated visible price range. */
  verticalZoom: number;
  autoPriceScale: boolean;
  rightGapBars: number;
}
export type VisualProfiles = Partial<Record<VisualProfileKey, VisualChartProfile>>;

const BASE: Record<VisualContextId, VisualChartProfile> = {
  screenerQuick: { visibleBars: 65, verticalZoom: 1, autoPriceScale: true, rightGapBars: 10 },
  screenerFull: { visibleBars: 110, verticalZoom: 1, autoPriceScale: true, rightGapBars: 12 },
  formationsQuick: { visibleBars: 78, verticalZoom: 1, autoPriceScale: true, rightGapBars: 12 },
  formationsFull: { visibleBars: 125, verticalZoom: 1, autoPriceScale: true, rightGapBars: 15 },
  terminalLarge: { visibleBars: 120, verticalZoom: 1, autoPriceScale: true, rightGapBars: 8 },
  terminalMedium: { visibleBars: 70, verticalZoom: 1, autoPriceScale: true, rightGapBars: 7 },
  terminalCompact: { visibleBars: 36, verticalZoom: 1, autoPriceScale: true, rightGapBars: 5 },
};

export function visualDeviceForWidth(viewportWidth: number): VisualDevice {
  return Number.isFinite(viewportWidth) && viewportWidth < 768 ? 'mobile' : 'desktop';
}

export function visualContextForTerminalWidth(chartWidth: number): VisualContextId {
  if (chartWidth < 440) return 'terminalCompact';
  if (chartWidth < 800) return 'terminalMedium';
  return 'terminalLarge';
}

export function makeVisualProfileKey(context: VisualContextId, device: VisualDevice): VisualProfileKey {
  return \`\${context}:\${device}\`;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value)) : fallback;
}

export function normalizeVisualProfile(value: unknown, context: VisualContextId): VisualChartProfile {
  const defaults = BASE[context];
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<VisualChartProfile> : {};
  return {
    visibleBars: Math.round(clamp(raw.visibleBars, 15, 500, defaults.visibleBars)),
    verticalZoom: Math.round(clamp(raw.verticalZoom, 0.4, 4, defaults.verticalZoom) * 100) / 100,
    autoPriceScale: typeof raw.autoPriceScale === 'boolean' ? raw.autoPriceScale : defaults.autoPriceScale,
    rightGapBars: Math.round(clamp(raw.rightGapBars, 0, 100, defaults.rightGapBars)),
  };
}

export function normalizedVisualProfiles(value: unknown): VisualProfiles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const profiles: VisualProfiles = {};
  for (const context of VISUAL_CONTEXTS) {
    for (const device of ['mobile', 'desktop'] as const) {
      const key = makeVisualProfileKey(context.id, device);
      if (source[key] !== undefined) profiles[key] = normalizeVisualProfile(source[key], context.id);
    }
  }
  return profiles;
}

export function getVisualProfile(
  settings: Pick<HookChartPreferences, 'visualProfiles'> | undefined,
  context: VisualContextId,
  device: VisualDevice,
): VisualChartProfile {
  return normalizeVisualProfile(settings?.visualProfiles?.[makeVisualProfileKey(context, device)], context);
}

export function patchVisualProfile(
  source: VisualProfiles | undefined,
  key: VisualProfileKey,
  update: Partial<VisualChartProfile> | null,
): VisualProfiles {
  const result = { ...(source || {}) };
  if (update === null) { delete result[key]; return result; }
  const context = key.split(':')[0] as VisualContextId;
  result[key] = normalizeVisualProfile({ ...getVisualProfile({ visualProfiles: result }, context, key.endsWith(':mobile') ? 'mobile' : 'desktop'), ...update }, context);
  return result;
}

export function captureVisualProfile(
  current: VisualChartProfile,
  plotWidth: number,
  viewport: { barWidth: number; rightOffset: number; autoY: boolean; manualRange: number | null; yZoom?: number; fitAll?: boolean },
  autoPriceRange?: number,
): VisualChartProfile {
  const horizontalStep = viewport.fitAll || !Number.isFinite(viewport.barWidth) || viewport.barWidth <= 0
    ? plotWidth / current.visibleBars : viewport.barWidth;
  const visibleBars = Math.round(clamp(plotWidth / Math.max(.12, horizontalStep), 15, 500, current.visibleBars));
  const verticalZoom = !viewport.autoY && viewport.manualRange && autoPriceRange && autoPriceRange > 0
    ? autoPriceRange / viewport.manualRange : (viewport.yZoom ?? current.verticalZoom);
  return normalizeVisualProfile({
    ...current,
    visibleBars,
    verticalZoom,
    autoPriceScale: viewport.autoY,
    rightGapBars: viewport.rightOffset >= 0 && viewport.rightOffset <= 100 ? Math.round(viewport.rightOffset) : current.rightGapBars,
  }, 'screenerQuick');
}
