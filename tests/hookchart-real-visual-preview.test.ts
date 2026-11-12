import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HookChartVisualPreview } from '../src/components/hookchart/HookChartVisualPreview';
import { getVisualProfile } from '../src/components/hookchart/visualProfiles';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const previewSource = source('../src/components/hookchart/HookChartVisualPreview.tsx');
const settingsSource = source('../src/components/hookchart/OriginalHookChartSettings.tsx');
const canvasSource = source('../src/components/hookchart/HookChartCanvas.tsx');

const candles = Array.from({ length: 80 }, (_, index) => ({
  t: 1700000000000 + index * 3600000,
  o: 42500 + index * 12, h: 42580 + index * 12,
  l: 42450 + index * 12, c: 42545 + index * 12,
  v: 12 + index / 2, n: 0,
}));

test('real settings preview renders the HookChart canvas with actual OHLCV, price and time axis', () => {
  const html = renderToStaticMarkup(React.createElement(HookChartVisualPreview, {
    candles,
    symbol: 'BTCUSDT',
    timeframe: '1h',
    exchange: 'binance',
    marketType: 'futures',
    visualContext: 'screenerQuick',
    visualDevice: 'desktop',
    profile: getVisualProfile(undefined, 'screenerQuick', 'desktop'),
    onChange: () => {},
  }));
  assert.match(html, /class="hookchart-visual-preview-frame"/);
  assert.match(html, /class="chartWrap"/);
  assert.match(html, /<canvas/);
  assert.match(html, /aria-label="Графік BTCUSDT"/);
  assert.match(html, /class="chartTimeAxis"/);
  assert.match(html, /Binance/);
  assert.match(html, /Свічки відкритого графіка/);
  assert.match(html, /Зберегти масштаб із цього графіка/);
  assert.doesNotMatch(html, /Приклад відносного масштабу|не реальні котирування/);
});

test('settings editor replaces synthetic SVG with real HookChart preview and wires existing candles', () => {
  assert.match(settingsSource, /<HookChartVisualPreview/);
  assert.match(settingsSource, /profile=\{selectedProfile\}/);
  assert.match(settingsSource, /onChange=\{onProfileChange\}/);
  assert.match(settingsSource, /previewCandles=\{previewCandles\}/);
  assert.doesNotMatch(settingsSource, /const bars = Math\.max\(14, Math\.min\(72/);
  assert.doesNotMatch(settingsSource, /Приклад відносного масштабу/);
  assert.match(canvasSource, /previewCandles=\{candles\}/);
  assert.match(canvasSource, /previewSymbol=\{symbol\}/);
  assert.match(canvasSource, /previewTimeframe=\{timeframe\}/);
  assert.match(canvasSource, /!replay && panel === 'settings'/);
});

test('live preview never creates another exchange feed or changes drawing and alert persistence', () => {
  assert.match(previewSource, /import \{\s*Chart, ChartTimeAxis,/);
  assert.match(previewSource, /const useParentCandles = candles !== undefined/);
  assert.match(previewSource, /if \(useParentCandles\) return/);
  assert.match(previewSource, /fetchDirectKlines\('binance', 'spot', 'BTCUSDT', '1h', 700\)/);
  assert.match(previewSource, /showLiqRiskBlock=\{false\}/);
  assert.match(previewSource, /controlsContainer=\{null\}/);
  assert.match(previewSource, /onViewportChange=\{setViewport\}/);
  assert.match(previewSource, /captureVisualProfile\(/);
  assert.doesNotMatch(previewSource, /new WebSocket|setInterval|onCreatePriceAlert=|onNeedHistory=/);
});

test('phone and compact Terminal previews use the real canvas at limited widths', () => {
  assert.match(previewSource, /if \(device === 'mobile'\) return 354/);
  assert.match(previewSource, /if \(context === 'terminalCompact'\) return 370/);
  assert.match(previewSource, /style=\{\{ maxWidth: profilePreviewWidth\(visualContext, visualDevice\) \}\}/);
  const css = source('../src/components/hookchart/integration.css');
  assert.match(css, /hookchart-visual-preview-chart/);
  assert.match(css, /touch-action:none/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(previewSource, /Реальні свічки для прикладу/);
});

test('Replay chart is unaffected by the new chart-only settings preview', () => {
  const replay = source('../src/components/replay/ReplayChart.tsx');
  assert.doesNotMatch(replay, /HookChartVisualPreview|previewCandles|visualProfileEditor/);
});
