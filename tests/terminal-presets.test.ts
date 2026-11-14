import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { MarketCoin, TerminalChartBlock } from '../src/types';
import { matchesMarketPreset, selectMarketPresetCoins } from '../src/utils/marketPresets';
import { blocksForMarketPreset, normalizeTerminalBlocks, normalizeTerminalMarketPair, formatTerminalQuotedPrice, normalizeTerminalPresets, terminalStorageKey, TERMINAL_PRESETS_STORAGE_KEY } from '../src/utils/terminalPresets';

const coin = (symbol: string, change24h: number, values: Partial<MarketCoin> = {}): MarketCoin => ({
  symbol, baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT', exchange: 'binance', marketType: 'futures',
  price: 100, change24h, volumeUsd: 5_000_000, high24h: 101, low24h: 99,
  distanceToHighPct: 1, distanceToLowPct: 1, volatility24hPct: 8, volatility5mPct: 1,
  isNearHigh: true, isNearLow: true, isActiveCoin: true, exchangeUrl: '', ...values,
});
const all = { exchange: 'all', marketType: 'all' } as const;
const key = (item: MarketCoin) => `${item.symbol}:${item.exchange}:${item.marketType}`;

test('terminal gainers and losers use the screener categories and correct 24h ranking', () => {
  const data = [coin('FLATUSDT', 0), coin('AUSDT', 8), coin('BUSDT', -2), coin('CUSDT', 20), coin('DUSDT', -15)];
  assert.deepEqual(selectMarketPresetCoins(data, 'top_gainers', all, 4).map(item => item.symbol), ['CUSDT', 'AUSDT']);
  assert.deepEqual(selectMarketPresetCoins(data, 'top_losers', all, 4).map(item => item.symbol), ['DUSDT', 'BUSDT']);
  for (const preset of ['active', 'top_gainers', 'top_losers', 'near_highs', 'near_lows'] as const) {
    assert.equal(selectMarketPresetCoins(data, preset, all, 36).length, data.filter(item => matchesMarketPreset(item, preset)).length);
  }
});

test('active coins sort by 5m volatility; high and low categories sort by proximity', () => {
  const data = [coin('AUSDT', 1, { volatility5mPct: 0.8, distanceToHighPct: 1.5, distanceToLowPct: 0.1 }),
    coin('BUSDT', 1, { volatility5mPct: 3, distanceToHighPct: 0.1, distanceToLowPct: 1.5 }),
    coin('CUSDT', 1, { isActiveCoin: false, isNearHigh: false, isNearLow: false, volatility5mPct: 5 })];
  assert.deepEqual(selectMarketPresetCoins(data, 'active', all, 2).map(item => item.symbol), ['BUSDT', 'AUSDT']);
  assert.deepEqual(selectMarketPresetCoins(data, 'near_highs', all, 2).map(item => item.symbol), ['BUSDT', 'AUSDT']);
  assert.deepEqual(selectMarketPresetCoins(data, 'near_lows', all, 2).map(item => item.symbol), ['AUSDT', 'BUSDT']);
});

test('presets distinguish spot and futures on both exchanges and discard duplicate quotes', () => {
  const data = [coin('BTCUSDT', 2), coin('BTCUSDT', 2), coin('BTCUSDT', 4, { marketType: 'spot' }),
    coin('BTCUSDT', 8, { exchange: 'bybit' }), coin('BTCUSDT', 6, { exchange: 'bybit', marketType: 'spot' })];
  assert.equal(selectMarketPresetCoins(data, 'active', all, 9).length, 4);
  assert.deepEqual(selectMarketPresetCoins(data, 'top_gainers', { exchange: 'bybit', marketType: 'spot' }, 4).map(key), ['BTCUSDT:bybit:spot']);
});

test('limits and invalid prices cannot generate extra or fake charts; inputs remain untouched', () => {
  const data = Array.from({ length: 50 }, (_, index) => coin(`C${index}USDT`, index + 1));
  data.push(coin('BROKENUSDT', 100, { price: NaN }), coin('ZEROPRICEUSDT', 100, { price: 0 }));
  const original = [...data];
  assert.equal(selectMarketPresetCoins(data, 'top_gainers', all, 4).length, 4);
  assert.equal(selectMarketPresetCoins(data, 'top_gainers', all, 100).length, 36);
  // Terminal pages must be able to browse the same complete category as the screener.
  const allMatches = selectMarketPresetCoins(data, 'top_gainers', all, Number.POSITIVE_INFINITY);
  assert.equal(allMatches.length, 50);
  assert.equal(allMatches[0].symbol, 'C49USDT');
  assert.equal(allMatches.slice(0, 12).length + allMatches.slice(12, 24).length + allMatches.slice(24).length, 50);
  assert.equal(new Set(allMatches.map(key)).size, 50);
  assert.equal(selectMarketPresetCoins(data, 'top_gainers', all, -1).length, 0);
  assert.equal(selectMarketPresetCoins(data, 'top_gainers', all, NaN).length, 0);
  assert.deepEqual(selectMarketPresetCoins([], 'near_highs', all, 4), []);
  assert.deepEqual(data, original);
});

test('automatic refresh preserves widget IDs, timeframes and layout settings for unchanged coins', () => {
  const quotes = [coin('BTCUSDT', 4), coin('ETHUSDT', 3)];
  const blocks = blocksForMarketPreset([], quotes, '15m');
  blocks[0] = { ...blocks[0], timeframe: '1h', colSpan: 2 };
  assert.equal(blocksForMarketPreset(blocks, quotes, '5m'), blocks);
  const next = blocksForMarketPreset(blocks, [quotes[1], quotes[0], coin('SOLUSDT', 2)], '5m');
  assert.equal(next[1], blocks[0]);
  assert.equal(next[1].colSpan, 2);
  assert.equal(next[2].timeframe, '5m');
  assert.equal(new Set(next.map(block => block.id)).size, 3);
});

test('custom presets migrate legacy orderbook blocks to charts and preserve chart settings', () => {
  const blocks: TerminalChartBlock[] = blocksForMarketPreset([], [coin('BTCUSDT', 2, { exchange: 'bybit', marketType: 'spot' })], '4h');
  const legacyBlocks = blocks.map(block => ({ ...block, mode: 'combined', colSpan: 2,
    domSettings: { depth: 'deep', compression: 20 } }));
  const preset = { id: 'my-preset', name: 'Мої монети', blocks: legacyBlocks, columns: 3, blockHeight: 'large', createdAt: 123 };
  const normalized = normalizeTerminalPresets(JSON.parse(JSON.stringify([preset])));
  assert.equal(normalized[0].blocks[0].exchange, 'bybit');
  assert.equal(normalized[0].blocks[0].marketType, 'spot');
  assert.equal(normalized[0].blocks[0].timeframe, '4h');
  assert.equal(normalized[0].blocks[0].colSpan, 2);
  assert.equal('mode' in normalized[0].blocks[0], false);
  assert.equal('domSettings' in normalized[0].blocks[0], false);
  assert.deepEqual(normalizeTerminalPresets([{ ...preset, blocks: [] }]), []);
  assert.deepEqual(normalizeTerminalPresets([{ ...preset, blocks: [{ symbol: 'FAKEUSDT' }] }]), []);
  assert.equal(normalizeTerminalPresets([preset, preset]).length, 1);
  assert.deepEqual(normalizeTerminalPresets([]), []);
});

test('custom preset caches are isolated between users and guests', () => {
  const keys = [terminalStorageKey(TERMINAL_PRESETS_STORAGE_KEY, 'user-a'),
    terminalStorageKey(TERMINAL_PRESETS_STORAGE_KEY, 'user-b'), terminalStorageKey(TERMINAL_PRESETS_STORAGE_KEY)];
  assert.equal(new Set(keys).size, 3);
  const storage = new Map<string, string>();
  storage.set(keys[0], JSON.stringify([{ id: 'private-a', name: 'Мій пресет' }]));
  assert.equal(storage.get(keys[1]), undefined);
  assert.equal(storage.get(keys[2]), undefined);
});

test('loaded Terminal workspaces repair duplicate chart IDs without discarding their markets or preferences', () => {
  const previous: TerminalChartBlock[] = [
    { id: 'reused', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', exchange: 'binance', marketType: 'futures', timeframe: '4h', colSpan: 2 },
    { id: 'reused', symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', exchange: 'bybit', marketType: 'spot', timeframe: '15m', colSpan: 1 },
    { id: 'another', symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', exchange: 'binance', marketType: 'spot', timeframe: '1m', colSpan: 1 },
  ];
  const next = normalizeTerminalBlocks(previous);
  assert.equal(next.length, 3);
  assert.equal(new Set(next.map(block => block.id)).size, 3);
  assert.equal(next[0].id, 'reused');
  assert.notEqual(next[1].id, 'reused');
  assert.equal(next[1].exchange, 'bybit');
  assert.equal(next[1].marketType, 'spot');
  assert.equal(next[0].timeframe, '4h');
  assert.equal(next[0].colSpan, 2);
  assert.equal(next[2].id, 'another');
  assert.equal(previous[1].id, 'reused', 'must not mutate persisted data');
  assert.deepEqual(normalizeTerminalBlocks(next), next, 'migrated keys remain stable on reload');
});

test('Terminal keeps each exchange instrument quote currency instead of appending USDT', () => {
  assert.deepEqual(normalizeTerminalMarketPair('BTCUSDT', 'USDT'), { symbol: 'BTCUSDT', quoteAsset: 'USDT' });
  assert.deepEqual(normalizeTerminalMarketPair('BTCUSDC', 'USDC'), { symbol: 'BTCUSDC', quoteAsset: 'USDC' });
  assert.deepEqual(normalizeTerminalMarketPair('ETH/BTC', 'BTC'), { symbol: 'ETHBTC', quoteAsset: 'BTC' });
  assert.deepEqual(normalizeTerminalMarketPair('ETH', 'USDT'), { symbol: 'ETHUSDT', quoteAsset: 'USDT' });
  assert.deepEqual(normalizeTerminalMarketPair('SOLFDUSD', 'FDUSD'), { symbol: 'SOLFDUSD', quoteAsset: 'FDUSD' });
  assert.deepEqual(normalizeTerminalMarketPair('ETHBTC'), { symbol: 'ETHBTC', quoteAsset: 'BTC' });
  assert.deepEqual(normalizeTerminalMarketPair('SOLBTC', 'USDT'), { symbol: 'SOLBTC', quoteAsset: 'BTC' });
  assert.deepEqual(normalizeTerminalMarketPair('BTCUSDC', 'USDT'), { symbol: 'BTCUSDC', quoteAsset: 'USDC' });
  assert.deepEqual(normalizeTerminalMarketPair('WBTC'), { symbol: 'WBTCUSDT', quoteAsset: 'USDT' });
  assert.deepEqual(normalizeTerminalMarketPair('WBTCUSDT'), { symbol: 'WBTCUSDT', quoteAsset: 'USDT' });
});

test('Terminal displays non-USD quote assets without a misleading dollar sign', () => {
  assert.equal(formatTerminalQuotedPrice(0.025, 'BTC'), '0.02500 BTC');
  assert.equal(formatTerminalQuotedPrice(3.5, 'ETH'), '3.50 ETH');
  // A stablecoin quote is not a USD-denominated price. UI displays the
  // instrument's quote asset separately rather than inventing a dollar sign.
  assert.equal(formatTerminalQuotedPrice(10, 'USDT'), '10.00');
  assert.equal(formatTerminalQuotedPrice(10, 'USDC'), '10.00');
});

test('Terminal preset draft creation never deactivates automatic market refresh', () => {
  const panel = readFileSync(new URL('../src/components/terminal/TerminalPresetPanel.tsx', import.meta.url), 'utf8');
  const start = panel.indexOf('const openForm = useCallback(');
  const end = panel.indexOf('const savePreset =', start);
  assert.ok(start >= 0 && end > start);
  const handler = panel.slice(start, end);
  assert.doesNotMatch(handler, /onActivePresetChange\(null\)/);
  assert.match(handler, /setShowForm\(true\)/);
});

test('Terminal favorite preset construction indexes quotes and workspace blocks once', () => {
  const panel = readFileSync(new URL('../src/components/terminal/TerminalPresetPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /const favoritesQuotesBySymbol = useMemo\(\(\) => \{/);
  assert.match(panel, /const workspaceBlocksByMarket = useMemo\(\(\) =>/);
  assert.match(panel, /favoritesQuotesBySymbol\.get\(symbol\)/);
  assert.match(panel, /workspaceBlocksByMarket\.get\(coinMarketKey\(/);
  assert.doesNotMatch(panel, /snapshot\.coins\.filter\(coin => coin\.symbol === symbol/);
});
