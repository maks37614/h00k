import type {
  ExchangeId, MarketCoin, MarketType, ScreenerPresetFilter, ScreenerSearchConfig,
  ScreenerSearchPreset, ScreenerSortBy, SearchUserSettings,
} from '../types';
import { getCoinDistanceToHigh, getCoinDistanceToLow, getCoinVol5m } from './marketPresets';

export const MAX_SCREENER_SEARCH_PRESETS = 12;

export const SCREENER_SEARCH_SORT_OPTIONS: ReadonlyArray<{ value: ScreenerSortBy; label: string }> = [
  { value: 'volume', label: 'Обсяг 24г' },
  { value: 'priceChange', label: 'Зміна ціни 24г' },
  { value: 'price', label: 'Ціна' },
  { value: 'volatility', label: 'Волатильність' },
  { value: 'distanceToHigh', label: 'Відстань до максимуму' },
  { value: 'distanceToLow', label: 'Відстань до мінімуму' },
];

const presetFilters: ScreenerPresetFilter[] = ['all', 'active', 'top_gainers', 'top_losers', 'near_highs', 'near_lows'];
const sortKeys = new Set<ScreenerSortBy>(SCREENER_SEARCH_SORT_OPTIONS.map(option => option.value));

export const DEFAULT_SCREENER_SEARCH_CONFIG: ScreenerSearchConfig = {
  searchQuery: '',
  exchange: 'all',
  marketType: 'futures',
  maxVolumeUsd: 0,
  presetFilter: 'all',
  sortBy: 'volume',
  sortOrder: 'desc',
  secondarySortBy: 'none',
  secondarySortOrder: 'desc',
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function validSort(value: unknown): value is ScreenerSortBy {
  return typeof value === 'string' && sortKeys.has(value as ScreenerSortBy);
}

/** Avoid taking arbitrary, oversized or stale values from persisted profile JSON. */
export function normalizeScreenerSearchConfig(
  source: unknown,
  fallback: Partial<ScreenerSearchConfig> = DEFAULT_SCREENER_SEARCH_CONFIG,
): ScreenerSearchConfig {
  const raw = record(source);
  const base = { ...DEFAULT_SCREENER_SEARCH_CONFIG, ...fallback };
  const sortBy = validSort(raw.sortBy) ? raw.sortBy : base.sortBy;
  const secondarySortBy = validSort(raw.secondarySortBy) && raw.secondarySortBy !== sortBy
    ? raw.secondarySortBy : 'none';
  return {
    searchQuery: typeof raw.searchQuery === 'string' ? raw.searchQuery.slice(0, 80) : base.searchQuery,
    exchange: raw.exchange === 'all' || raw.exchange === 'binance' || raw.exchange === 'bybit'
      ? raw.exchange as 'all' | ExchangeId : base.exchange,
    marketType: raw.marketType === 'all' || raw.marketType === 'spot' || raw.marketType === 'futures'
      ? raw.marketType as 'all' | MarketType : base.marketType,
    maxVolumeUsd: typeof raw.maxVolumeUsd === 'number' && Number.isFinite(raw.maxVolumeUsd)
      ? Math.max(0, Math.min(1_000_000_000_000_000, raw.maxVolumeUsd)) : base.maxVolumeUsd,
    presetFilter: presetFilters.includes(raw.presetFilter as ScreenerPresetFilter)
      ? raw.presetFilter as ScreenerPresetFilter : base.presetFilter,
    sortBy,
    sortOrder: raw.sortOrder === 'asc' || raw.sortOrder === 'desc' ? raw.sortOrder : base.sortOrder,
    secondarySortBy,
    secondarySortOrder: raw.secondarySortOrder === 'asc' || raw.secondarySortOrder === 'desc'
      ? raw.secondarySortOrder : base.secondarySortOrder,
  };
}

export function normalizeScreenerSearchSettings(
  input: unknown,
  fallback: Partial<ScreenerSearchConfig> = DEFAULT_SCREENER_SEARCH_CONFIG,
): SearchUserSettings {
  const raw = record(input);
  const defaultConfig = normalizeScreenerSearchConfig(raw.defaultConfig, {
    ...DEFAULT_SCREENER_SEARCH_CONFIG, ...fallback,
    ...(presetFilters.includes(raw.presetFilter as ScreenerPresetFilter) ? { presetFilter: raw.presetFilter as ScreenerPresetFilter } : {}),
    ...(validSort(raw.sortBy) ? { sortBy: raw.sortBy } : {}),
    ...(raw.sortDirection === 'asc' || raw.sortDirection === 'desc' ? { sortOrder: raw.sortDirection } : {}),
  });
  const seen = new Set<string>();
  const presets: ScreenerSearchPreset[] = [];
  for (const item of Array.isArray(raw.presets) ? raw.presets.slice(0, MAX_SCREENER_SEARCH_PRESETS * 3) : []) {
    const value = record(item);
    const id = typeof value.id === 'string' ? value.id.slice(0, 80) : '';
    const name = typeof value.name === 'string' ? value.name.trim().slice(0, 40) : '';
    if (!id || !name || seen.has(id) || presets.length >= MAX_SCREENER_SEARCH_PRESETS) continue;
    seen.add(id);
    presets.push({ id, name, config: normalizeScreenerSearchConfig(value.config, defaultConfig) });
  }
  const defaultPresetId = typeof raw.defaultPresetId === 'string' && presets.some(x => x.id === raw.defaultPresetId)
    ? raw.defaultPresetId : null;
  return { defaultConfig, presets, defaultPresetId };
}

export function effectiveScreenerSearchConfig(
  input: unknown,
  fallback: Partial<ScreenerSearchConfig> = DEFAULT_SCREENER_SEARCH_CONFIG,
): ScreenerSearchConfig {
  const settings = normalizeScreenerSearchSettings(input, fallback);
  const preset = settings.presets?.find(item => item.id === settings.defaultPresetId);
  return preset?.config ?? settings.defaultConfig ?? normalizeScreenerSearchConfig(undefined, fallback);
}

function sortValue(coin: MarketCoin, field: ScreenerSortBy): number {
  switch (field) {
    case 'volume': return coin.volumeUsd;
    case 'priceChange': return coin.change24h;
    case 'price': return coin.price;
    case 'volatility': return getCoinVol5m(coin);
    case 'distanceToHigh': return getCoinDistanceToHigh(coin);
    case 'distanceToLow': return getCoinDistanceToLow(coin);
  }
}

/** Sort the already loaded Screener coin array; never starts exchange/network requests. */
export function compareScreenerSearchCoins(
  a: MarketCoin,
  b: MarketCoin,
  config: Pick<ScreenerSearchConfig, 'sortBy' | 'sortOrder' | 'secondarySortBy' | 'secondarySortOrder'>,
): number {
  const compare = (field: ScreenerSortBy, order: 'asc' | 'desc') => {
    const left = sortValue(a, field), right = sortValue(b, field);
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return order === 'asc' ? left - right : right - left;
  };
  const primary = compare(config.sortBy, config.sortOrder);
  if (primary !== 0) return primary;
  if (config.secondarySortBy !== 'none' && config.secondarySortBy !== config.sortBy) {
    const secondary = compare(config.secondarySortBy, config.secondarySortOrder);
    if (secondary !== 0) return secondary;
  }
  return a.symbol.localeCompare(b.symbol) || a.exchange.localeCompare(b.exchange)
    || a.marketType.localeCompare(b.marketType);
}
