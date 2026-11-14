import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalSettingsDrawer } from '../src/components/terminal/TerminalSettingsDrawer';
import { getVisualProfile, normalizeVisualProfile } from '../src/components/hookchart/visualProfiles';
import type { TerminalWorkspaceConfig } from '../src/types';

const source = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const defaultConfig: TerminalWorkspaceConfig = {
  layoutPreset: 'custom', columns: 2, autoFitScreen: true,
  blocks: [], showFormations: true, blockHeight: 'medium',
};

const drawer = (config: TerminalWorkspaceConfig) => renderToStaticMarkup(
  React.createElement(TerminalSettingsDrawer, {
    isOpen: true,
    onClose: () => {},
    config,
    coinSelection: { exchange: 'all', marketType: 'all' },
    coinLimit: 12,
    onUpdateConfig: () => {},
    onApplyGlobalTimeframe: () => {},
    onApplyPreset: () => {},
    onResetWorkspace: () => {},
    totalBlocks: 3,
  }),
);

test('terminal settings show starting chart view controls independently of global layout settings', () => {
  const html = drawer(defaultConfig);
  assert.match(html, /Початковий показ графіків/);
  for (const name of [
    'Початкова кількість свічок Термінала',
    'Початковий відступ Термінала в барах',
    'Початковий вертикальний масштаб Термінала',
    'Початковий автоматичний масштаб ціни Термінала',
    'Відновити типовий показ графіків',
  ]) assert.ok(html.includes(name), name);
  assert.match(html, /Масштаб і відступ під час відкриття/);
  assert.match(html, /Застосувати початковий вигляд/);
  const settings = source('../src/components/terminal/TerminalSettingsDrawer.tsx');
  assert.match(settings, /setInitial\(previous => \(\{ \.\.\.previous, \.\.\.patch \}\)\)/);
  assert.match(settings, /onClick=\{\(\) => onUpdateConfig\(\{ initialChartView: initial \}\)\}/);
});

test('saved terminal values appear in the terminal drawer and invalid values are clamped', () => {
  const base = getVisualProfile(undefined, 'terminalMedium', 'desktop');
  const custom = { ...base, visibleBars: 205, rightGapBars: 31, verticalZoom: 1.8, autoPriceScale: false };
  const html = drawer({ ...defaultConfig, initialChartView: custom });
  assert.match(html, /205/);
  assert.match(html, /31 барів/);
  assert.match(html, /1\.80/);
  const normalized = normalizeVisualProfile({
    ...custom, visibleBars: 10_000, rightGapBars: -99, verticalZoom: Infinity,
  }, 'terminalMedium');
  assert.equal(normalized.visibleBars, 500);
  assert.equal(normalized.rightGapBars, 0);
  assert.ok(Number.isFinite(normalized.verticalZoom));
});

test('initial terminal view is stored in existing profile workspace, not a new global preference', () => {
  const types = source('../src/types.ts');
  const hook = source('../src/utils/useTerminalWorkspace.ts');
  const page = source('../src/components/TerminalPage.tsx');
  assert.match(types, /initialChartView\?: VisualChartProfile/);
  assert.match(hook, /config\.initialChartView = normalizeVisualProfile\(config\.initialChartView, 'terminalMedium'\)/);
  assert.match(hook, /terminalSettings:/);
  assert.match(page, /terminalInitialView=\{config\.initialChartView\}/);
  assert.match(page, /<TerminalSettingsDrawer/);
});

test('terminal chart initial view is passed only through terminal widgets to HookChart, never Replay', () => {
  const page = source('../src/components/TerminalPage.tsx');
  const widget = source('../src/components/terminal/TerminalChartWidget.tsx');
  const wrapper = source('../src/components/ExchangeCandlestickChart.tsx');
  const chart = source('../src/components/TradingViewChart.tsx');
  const canvas = source('../src/components/hookchart/HookChartCanvas.tsx');
  assert.match(widget, /terminalInitialView=\{useIntegratedHookChartToolbar \? terminalInitialView : undefined\}/);
  assert.match(wrapper, /terminalInitialView=\{terminalInitialView\}/);
  assert.match(chart, /terminalInitialView=\{terminalInitialView\}/);
  assert.match(canvas, /terminalMode && terminalInitialView/);
  assert.match(canvas, /normalizeVisualProfile\(terminalInitialView, activeVisualContext\)/);
  assert.match(canvas, /activeVisualProfile\?\.rightGapBars/);
  assert.match(page, /visualContext="terminalLarge"/);
  assert.doesNotMatch(source('../src/components/replay/ReplayChart.tsx'), /terminalInitialView/);
  assert.doesNotMatch(source('../src/components/ScreenerTable.tsx'), /terminalInitialView/);
});

test('single-chart Terminal renders the timeframe saved on its block instead of stale global selection', () => {
  const page = source('../src/components/TerminalPage.tsx');
  assert.match(page, /const activeTimeframe = blocks\.length === 1 \? blocks\[0\]\.timeframe : timeframe/);
  assert.match(page, /switch \(activeTimeframe\)/);
  assert.match(page, /timeframe=\{activeTimeframe\}/);
  assert.match(page, /activeTimeframe === tf/);
  assert.match(page, /Таймфрейм: <strong[^>]*>\{activeTimeframe\}<\/strong>/);
});

test('maximizing one Terminal chart suspends other visible charts without changing their settings', () => {
  const page = source('../src/components/TerminalPage.tsx');
  const widget = source('../src/components/terminal/TerminalChartWidget.tsx');
  assert.match(page, /isSuspended=\{maximizedBlockId !== null && !isMaximized\}/);
  assert.match(widget, /const shouldLoadWidgets = !isSuspended && \(isSingleBlock \|\| isMaximized \|\| isNearViewport\)/);
  assert.match(widget, /if \(!shouldLoadWidgets \|\| useIntegratedHookChartToolbar\) return;/);
  assert.match(widget, /\{shouldLoadWidgets \? \(/);
});

test('Terminal coin changes clear pending prices from a prior instrument', () => {
  const widget = source('../src/components/terminal/TerminalChartWidget.tsx');
  assert.match(widget, /previousInstrumentRef\.current === instrumentKey/);
  assert.match(widget, /activeInstrumentRef\.current !== instrumentKey/);
  assert.match(widget, /clearTimeout\(headerPriceTimerRef\.current\)/);
  assert.match(widget, /pendingHeaderPriceRef\.current = null/);
  assert.match(widget, /setCurrentPrice\(nextPrice\)/);
  assert.match(widget, /setLivePrice\(nextPrice \?\? 0\)/);
});

test('Terminal renders truthful quote status, unique rapid-add IDs and indexed market lookups', () => {
  const page = source('../src/components/TerminalPage.tsx');
  assert.match(page, /const quotesAvailable = marketSnapshot\.timestamp !== null/);
  assert.match(page, /Date\.now\(\) - marketSnapshot\.timestamp <= 90_000/);
  assert.match(page, /!marketError && !marketSnapshot\.warning/);
  assert.doesNotMatch(page, />WLive</);
  assert.match(page, /Math\.random\(\)\.toString\(36\)\.slice\(2, 10\)/);
  assert.match(page, /const coinsByMarket = useMemo\(\(\) => \{/);
  assert.match(page, /coinsByMarket\.get\(coinMarketKey\(block\)\)/);
});

test('Terminal does not poll market quotes while hidden and refreshes safely on return', () => {
  const page = source('../src/components/TerminalPage.tsx');
  assert.match(page, /document\.visibilityState === 'hidden'/);
  assert.match(page, /document\.visibilityState === 'visible'/);
  assert.match(page, /now - lastRequestAt < 25_000/);
  assert.match(page, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/);
  assert.match(page, /document\.removeEventListener\('visibilitychange', onVisibilityChange\)/);
  assert.match(page, /controller\.abort\(\)/);
});

test('Terminal header actions cannot target the wrong symbol in multi-chart mode', () => {
  const page = source('../src/components/TerminalPage.tsx');
  const widget = source('../src/components/terminal/TerminalChartWidget.tsx');
  assert.match(page, /const hasHeaderTarget = blocks\.length === 1 && coinMarketKey\(activeCoin\) === coinMarketKey\(blocks\[0\]\)/);
  assert.match(page, /onOpenTelegramAlerts && hasHeaderTarget/);
  assert.match(page, /onSendMetaScalp && hasHeaderTarget/);
  assert.match(widget, /onSendMetaScalp\(coin\)/);
  assert.match(widget, /onOpenTelegramAlerts\(\{/);
});

test('closed per-chart coin switchers do not rescan the entire Terminal market', () => {
  const widget = source('../src/components/terminal/TerminalChartWidget.tsx');
  assert.match(widget, /const filteredCoins = useMemo\(\(\) => \{\s*if \(!isCoinPickerOpen\) return \[\];/);
  assert.match(widget, /\}, \[allCoins, coinSearch, isCoinPickerOpen\]\)/);
});

test('1x–4x Terminal layout buttons never remove, replace or reorder existing chart blocks', () => {
  const page = source('../src/components/TerminalPage.tsx');
  const start = page.indexOf('title="1 колонка (зберегти всі графіки)"');
  const sectionStart = page.lastIndexOf('<button', start);
  const end = page.indexOf('{/* Timeframe Selector */}', start);
  assert.ok(sectionStart >= 0 && end > sectionStart, 'layout controls must exist');
  const layout = page.slice(sectionStart, end);
  assert.doesNotMatch(layout, /setBlocks\(/, 'column selectors must not discard chart blocks');
  assert.doesNotMatch(layout, /handleApplyPreset\(/, 'column selectors must not replace selected coins');
  for (const columns of [1, 2, 3, 4]) {
    assert.match(layout, new RegExp('columns: ' + columns + ', autoFitScreen: true'));
  }
  assert.match(layout, /config\.columns === 1/);
});

test('Terminal preserves actual quote timestamp instead of claiming every refreshed card is fresh', () => {
  const page = source('../src/components/TerminalPage.tsx');
  assert.match(page, /timeframe: preferences\.defaultTimeframe, lastUpdated: marketSnapshot\.timestamp \?\? 0/);
  assert.match(page, /\[marketCoins, marketSnapshot\.timestamp, formationCoins, preferences\.defaultTimeframe\]/);
});

test('favorite click is visible in multi-chart mode and never wipes existing charts', () => {
  const page = source('../src/components/TerminalPage.tsx');
  const start = page.indexOf('const handleSelectFavoriteCoin =');
  const end = page.indexOf('// Build TradingView Embed URL', start);
  assert.ok(start >= 0 && end > start);
  const handler = page.slice(start, end);
  assert.match(handler, /setIsFavoritesDrawerOpen\(false\)/);
  assert.match(handler, /if \(blocks\.length === 1\)/);
  assert.match(handler, /setBlocks\(previous => previous\.map\(block => \(\{/);
  assert.match(handler, /\.\.\.block, symbol: favCoin\.symbol/);
  assert.match(handler, /const alreadyOpen = blocks\.find\(block => coinMarketKey\(block\) === coinMarketKey\(favCoin\)\)/);
  assert.match(handler, /setMaximizedBlockId\(alreadyOpen\.id\)/);
  assert.match(handler, /if \(blocks\.length >= MAX_TERMINAL_CHARTS\)/);
  assert.match(handler, /setBlocks\(previous => previous\.length >= MAX_TERMINAL_CHARTS \? previous : \[\.\.\.previous, nextBlock\]\)/);
  assert.doesNotMatch(handler, /setBlocks\(\[/, 'favorite selection must not discard the grid');
  assert.match(page, /blocks\.some\(block => coinMarketKey\(block\) === coinMarketKey\(favCoin\)\)/);
});

test('Terminal favorites prefer the exact open exchange and market, not arbitrary first ticker', () => {
  const page = source('../src/components/TerminalPage.tsx');
  const start = page.indexOf('// Favorites are keyed by symbol');
  const end = page.indexOf('const filteredFavorites =', start);
  assert.ok(start >= 0 && end > start);
  const resolver = page.slice(start, end);
  assert.match(resolver, /const openMarketsBySymbol = new Map\(blocks\.map/);
  assert.match(resolver, /open && matches\.find\(coin => coinMarketKey\(coin\) === coinMarketKey\(open\)\)/);
  assert.match(resolver, /matches\.find\(coin => coin\.exchange === preferredExchange && coin\.marketType === preferredMarket\)/);
  assert.match(resolver, /exchange: open\?\.exchange \|\| preferredExchange/);
  assert.match(resolver, /marketType: open\?\.marketType \|\| preferredMarket/);
  assert.doesNotMatch(resolver, /if \(!coinsMap\.has\(c\.symbol\)\)/);
});

test('legacy workspaces with over 50 charts paginate without discarding saved charts', () => {
  const page = source('../src/components/TerminalPage.tsx');
  assert.match(page, /const visibleWorkspaceBlocks = useMemo\(\(\) => blocks\.slice\(/);
  assert.match(page, /visibleWorkspaceStart \+ MAX_TERMINAL_CHARTS/);
  assert.match(page, /\{visibleWorkspaceBlocks\.map\(\(block, index\) => \{/);
  assert.match(page, /handleDragStart\(visibleWorkspaceStart \+ index\)/);
  assert.match(page, /handleDrop\(visibleWorkspaceStart \+ index\)/);
  assert.match(page, /aria-label="Сторінки великої робочої області"/);
  assert.match(page, /setWorkspacePage\(Math\.floor\(blockIndex \/ MAX_TERMINAL_CHARTS\)\)/);
  assert.match(page, /blocks\.length < MAX_TERMINAL_CHARTS && <div/);
  const gridStart = page.indexOf('/* Multi-chart Grid Layout */');
  const gridEnd = page.indexOf('{/* Add Chart Modal */}', gridStart);
  assert.ok(gridStart >= 0 && gridEnd > gridStart);
  assert.doesNotMatch(page.slice(gridStart, gridEnd), /\{blocks\.map\(/);
});

test('terminal profile sync rejects cross-device changes and keeps a recoverable local backup', () => {
  const hook = source('../src/utils/useTerminalWorkspace.ts');
  const panel = source('../src/components/terminal/TerminalPresetPanel.tsx');
  const auth = source('../src/context/AuthContext.tsx');
  const backend = source('../server/pgIdentity.ts');
  assert.match(hook, /auth\.updateTerminalWorkspace\(\{/);
  assert.match(hook, /serverVersion\.current/);
  assert.match(hook, /error\.code === 'TERMINAL_WORKSPACE_CONFLICT'/);
  assert.match(hook, /syncConflictRef\.current/);
  assert.match(hook, /onDownloadLocalBackup|downloadLocalBackup/);
  assert.match(panel, /syncConflict \? 'Інший пристрій/);
  assert.match(panel, /Завантажити локальну копію/);
  assert.match(auth, /updateTerminalWorkspace: \(/);
  assert.match(backend, /COALESCE\(profile -> 'terminalSettings' ->> 'version', ''\) = \$3/);
  assert.match(backend, /new AuthFailure\(409, .*'TERMINAL_WORKSPACE_CONFLICT'\)/);
});

test('old Terminal workspaces stay readable and the server issues new revision tokens', () => {
  const preset = source('../src/utils/useTerminalWorkspace.ts');
  const types = source('../src/types.ts');
  const backend = source('../server/pgIdentity.ts');
  assert.match(preset, /normalizeTerminalBlocks\(settings\.blocks\)/);
  assert.match(types, /interface TerminalWorkspaceSettings \{[\s\S]*?version\?: string;/);
  assert.match(backend, /patch\.terminalSettings = \{ \.\.\.safeWorkspace, version: randomUUID\(\) \}/);
});
