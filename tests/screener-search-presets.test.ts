import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { MarketCoin } from '../src/types';
import {
  DEFAULT_SCREENER_SEARCH_CONFIG, MAX_SCREENER_SEARCH_PRESETS,
  compareScreenerSearchCoins, effectiveScreenerSearchConfig,
  normalizeScreenerSearchConfig, normalizeScreenerSearchSettings,
} from '../src/utils/screenerSearchSettings';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const coin = (symbol: string, volumeUsd: number, change24h: number): MarketCoin => ({
  symbol, baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT',
  exchange: 'binance', marketType: 'futures', price: 10,
  change24h, volumeUsd, high24h: 11, low24h: 9,
  distanceToHighPct: 10, distanceToLowPct: 10, volatility24hPct: 2,
  isNearHigh: false, isNearLow: false, isActiveCoin: false,
  exchangeUrl: '',
});

test('Screener search defaults are local and legacy account settings stay readable', () => {
  assert.equal(DEFAULT_SCREENER_SEARCH_CONFIG.sortBy, 'volume');
  assert.equal(DEFAULT_SCREENER_SEARCH_CONFIG.secondarySortBy, 'none');
  const settings = normalizeScreenerSearchSettings({ presetFilter: 'active', sortBy: 'price', sortDirection: 'asc' },
    { exchange: 'bybit', marketType: 'spot' });
  assert.equal(settings.defaultConfig?.presetFilter, 'active');
  assert.equal(settings.defaultConfig?.sortBy, 'price');
  assert.equal(settings.defaultConfig?.sortOrder, 'asc');
  assert.equal(settings.defaultConfig?.exchange, 'bybit');
  assert.equal(settings.defaultConfig?.marketType, 'spot');
});

test('account preset defaults load and invalid preset references safely fall back', () => {
  const filters = {
    ...DEFAULT_SCREENER_SEARCH_CONFIG, exchange: 'bybit' as const, marketType: 'spot' as const,
    searchQuery: 'BTC', maxVolumeUsd: 5_000_000, sortBy: 'priceChange' as const,
    sortOrder: 'asc' as const, secondarySortBy: 'volume' as const,
  };
  const saved = normalizeScreenerSearchSettings({
    defaultConfig: DEFAULT_SCREENER_SEARCH_CONFIG,
    defaultPresetId: 'mine',
    presets: [{ id: 'mine', name: 'My scalping', config: filters }],
  });
  const selected = effectiveScreenerSearchConfig(saved);
  assert.deepEqual(selected, filters);
  assert.equal(effectiveScreenerSearchConfig({ ...saved, defaultPresetId: 'deleted' }).sortBy, 'volume');
  assert.equal(saved.presets?.[0]?.name, 'My scalping');
});

test('imported preset values are bounded and secondary sorts cannot duplicate primary', () => {
  const data = normalizeScreenerSearchConfig({
    searchQuery: 'A'.repeat(200), exchange: 'invalid', maxVolumeUsd: Number.POSITIVE_INFINITY,
    sortBy: 'price', secondarySortBy: 'price',
  });
  assert.equal(data.searchQuery.length, 80);
  assert.equal(data.exchange, 'all');
  assert.equal(data.maxVolumeUsd, 0);
  assert.equal(data.secondarySortBy, 'none');
  const tooMany = normalizeScreenerSearchSettings({
    presets: Array.from({ length: 25 }, (_, index) => ({
      id: String(index), name: 'Preset ' + index, config: data,
    })),
  });
  assert.equal(tooMany.presets?.length, MAX_SCREENER_SEARCH_PRESETS);
});

test('local multi-priority sort uses primary metric, then secondary on ties', () => {
  const a = coin('AAAUSDT', 10_000, 3);
  const b = coin('BBBUSDT', 10_000, 6);
  const c = coin('CCCUSDT', 20_000, 1);
  const config = { sortBy: 'volume' as const, sortOrder: 'desc' as const,
    secondarySortBy: 'priceChange' as const, secondarySortOrder: 'desc' as const };
  const ordered = [a, c, b].sort((left, right) => compareScreenerSearchCoins(left, right, config));
  assert.deepEqual(ordered.map(item => item.symbol), ['CCCUSDT', 'BBBUSDT', 'AAAUSDT']);
  const reversed = [a, c, b].sort((left, right) => compareScreenerSearchCoins(left, right,
    { ...config, secondarySortOrder: 'asc' }));
  assert.deepEqual(reversed.map(item => item.symbol), ['CCCUSDT', 'AAAUSDT', 'BBBUSDT']);
});

test('profile search settings are confined to coin Screener and legacy HookChart sorting is removed', () => {
  const profile = source('../src/components/UserProfileModal.tsx');
  const editor = source('../src/components/profile/ProfileScreenerSearchSettings.tsx');
  const screener = source('../src/components/CoinScreenerPage.tsx');
  const hook = source('../src/components/hookchart/OriginalHookChartSettings.tsx');
  assert.match(profile, /setActiveProfileSection\('search'\)/);
  assert.match(profile, /<ProfileScreenerSearchSettings/);
  assert.match(editor, /updateProfileData\(\{ searchSettings:/);
  assert.match(editor, /Зберегти як налаштування за замовчуванням/);
  assert.match(editor, /Мої пресети/);
  assert.match(screener, /id="screener-custom-search-preset"/);
  assert.match(screener, /applySearchConfig\(selected\.config\)/);
  assert.match(screener, /result\.sort\(\(a, b\) => compareScreenerSearchCoins/);
  assert.doesNotMatch(hook, /Дані та сортування|Типи та порядок сортування|Інтервали аналізу/);
});

test('account switching and failed preset writes cannot leak search settings', () => {
  const app = source('../src/App.tsx');
  const editor = source('../src/components/profile/ProfileScreenerSearchSettings.tsx');
  const screener = source('../src/components/CoinScreenerPage.tsx');
  assert.match(app, /<CoinScreenerPage\s+key=\{user\?\.uid \|\| 'guest'\}/);
  assert.match(editor, /await updateProfileData\(\{ searchSettings:/);
  assert.match(editor, /if \(saved\) setEditingId\(id\)/);
  assert.match(editor, /return false;/);
  assert.match(screener, /const cachedUi = screenerUiSession\.get\(user\?\.uid \|\| 'guest'\)/);
});

test('empty symbol search explains and preserves full-market filtering', () => {
  const editor = source('../src/components/profile/ProfileScreenerSearchSettings.tsx');
  const screener = source('../src/components/CoinScreenerPage.tsx');
  assert.match(editor, /Якщо залишити поле порожнім, скрінер шукатиме всі монети/);
  assert.match(screener, /if \(searchQuery\.trim\(\) && !matchesExchangeInstrumentSearch/);
});
