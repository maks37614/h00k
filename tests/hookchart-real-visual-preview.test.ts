import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HookChartVisualPreview } from '../src/components/hookchart/HookChartVisualPreview';
import { getVisualProfile } from '../src/components/hookchart/visualProfiles';
import { demoDragProfile, demoPinchProfile, demoWheelProfile, demoZoomBars } from '../src/components/hookchart/syntheticPreviewModel';

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

test('visual settings render a synthetic responsive candle editor, not a nested HookChart', () => {
  const html = renderToStaticMarkup(React.createElement(HookChartVisualPreview, {
    candles, symbol: 'BTCUSDT', timeframe: '1h', exchange: 'binance',
    marketType: 'futures', visualContext: 'screenerQuick', visualDevice: 'desktop',
    profile: getVisualProfile(undefined, 'screenerQuick', 'desktop'), onChange: () => {},
  }));
  assert.match(html, /class="hookchart-visual-preview-frame"/);
  assert.match(html, /<svg[^>]*class="hookchart-synthetic-preview"/);
  assert.match(html, /role="application"/);
  assert.match(html, /DEMO · OHLCV/);
  assert.match(html, /Штучні дані/);
  assert.match(html, /Зберегти масштаб із цього графіка/);
  assert.match(html, /Автоціна/);
  assert.doesNotMatch(html, /<canvas|chartCanvasSurface|Реальні свічки|Binance · Futures/);
});

test('editor reuses the same account visual profile for sliders and synthetic preview', () => {
  assert.match(settingsSource, /<HookChartVisualPreview/);
  assert.match(settingsSource, /profile=\{selectedProfile\}/);
  assert.match(settingsSource, /onChange=\{onProfileChange\}/);
  assert.match(settingsSource, /previewCandles=\{previewCandles\}/);
  assert.match(canvasSource, /previewCandles=\{candles\}/);
  assert.match(canvasSource, /previewSymbol=\{symbol\}/);
});

test('synthetic editor never starts exchange requests, real HookChart, websockets or timers', () => {
  assert.doesNotMatch(previewSource, /fetchDirectKlines|toHookCandles|<Chart|ChartTimeAxis|new WebSocket|setInterval|onNeedHistory/);
  assert.match(previewSource, /syntheticBar\(/);
  assert.match(previewSource, /changeRef\.current\(next\)/);
  assert.match(previewSource, /onPointerMove=\{onPointerMove\}/);
  assert.match(previewSource, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
  assert.match(previewSource, /changeRef\.current\(\{ \.\.\.profileRef\.current \}\)/);
});

test('demo horizontal/vertical drag immediately updates the exact numeric settings', () => {
  const current = { visibleBars: 144, rightGapBars: 81, verticalZoom: .4, autoPriceScale: true };
  const moved = demoDragProfile(current, -40, -40);
  assert.ok(moved.rightGapBars > current.rightGapBars, 'moving candles left increases future space');
  assert.ok(moved.verticalZoom > current.verticalZoom, 'moving upward increases candle height');
  assert.equal(moved.visibleBars, current.visibleBars);
  assert.equal(moved.autoPriceScale, current.autoPriceScale);

  const reverse = demoDragProfile(current, 40, 40);
  assert.ok(reverse.rightGapBars < current.rightGapBars);
  assert.ok(reverse.verticalZoom < current.verticalZoom);
});

test('pinch and wheel update the visible-candle setting without interfering with the gap', () => {
  const current = { visibleBars: 144, rightGapBars: 81, verticalZoom: .4, autoPriceScale: true };
  const horizontal = demoPinchProfile(current, 200, 300, 3, 4);
  assert.ok(horizontal.visibleBars < 144);
  assert.equal(horizontal.verticalZoom, .4, 'horizontal pinch must not squeeze candles vertically');
  assert.equal(horizontal.rightGapBars, 81);
  const vertical = demoPinchProfile(current, 4, 6, 100, 180);
  assert.equal(vertical.visibleBars, 144);
  assert.ok(vertical.verticalZoom > .4);
  assert.ok(demoWheelProfile(current, 100).visibleBars > 144);
  assert.ok(demoZoomBars(current, .8).visibleBars < 144);
});

test('phone and compact Terminal use a capped synthetic preview size', () => {
  assert.match(previewSource, /if \(device === 'mobile'\) return 354/);
  assert.match(previewSource, /if \(context === 'terminalCompact'\) return 370/);
  assert.match(previewSource, /style=\{\{ maxWidth: profilePreviewWidth\(visualContext, visualDevice\) \}\}/);
  const css = source('../src/components/hookchart/integration.css');
  assert.match(css, /hookchart-synthetic-preview/);
  assert.match(css, /touch-action:none/);
  assert.match(previewSource, /onPointerCancel=\{onPointerEnd\}/);
});

test('Replay stays independent of the synthetic settings editor', () => {
  const replay = source('../src/components/replay/ReplayChart.tsx');
  assert.doesNotMatch(replay, /HookChartVisualPreview|syntheticPreviewModel|visualProfileEditor/);
});

test('saved visual profiles still reinitialize real charts on coin/timeframe changes', () => {
  const engine = source('../src/components/hookchart/engine.tsx');
  assert.match(engine, /const signature=\[symbol,tf,visualProfileKey,visualProfile\.visibleBars/);
  assert.match(engine, /\},\[symbol,tf,visualProfileKey,visualProfileCaptureVersion,visualProfile\?\.visibleBars/);
  assert.match(engine, /if\(visualAppliedRef\.current===signature\)return/);
  assert.match(engine, /const minBar=\.12/);
  const horizontal = source('../src/utils/hookchartData.ts');
  assert.match(horizontal, /Math\.max\(\.12, viewport\.barWidth\)/);
});

test('saved visual profiles still take precedence over stale per-coin ranges', () => {
  const engine = source('../src/components/hookchart/engine.tsx');
  assert.match(engine, /if\(!visualProfile\|\|!visualProfileKey\|\|!candles\.length\)return/);
  assert.match(engine, /if\(visualProfile\|\|rangeRestored\.current\|\|!candles\.length\|\|!initialLogicalRange\)return/);
  assert.match(canvasSource, /visualProfile=\{activeVisualProfile\}/);
  assert.match(engine, /barWidth,rightOffset:0,autoY:priceAuto/);
});
