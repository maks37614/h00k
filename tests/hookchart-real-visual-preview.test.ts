import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HookChartVisualPreview } from '../src/components/hookchart/HookChartVisualPreview';
import { createSyntheticPreviewCandles } from '../src/components/hookchart/syntheticPreviewCandles';
import { getVisualProfile } from '../src/components/hookchart/visualProfiles';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const previewSource = source('../src/components/hookchart/HookChartVisualPreview.tsx');
const settingsSource = source('../src/components/hookchart/OriginalHookChartSettings.tsx');

const base = getVisualProfile(undefined, 'screenerQuick', 'mobile');

test('profile editor shows small read-only SVG preview, not an interactive canvas', () => {
  const html = renderToStaticMarkup(React.createElement(HookChartVisualPreview, {
    profile: base,
  }));
  assert.match(html, /data-synthetic-hookchart="true"/);
  assert.match(html, /class="hookchart-mini-preview"/);
  assert.match(html, /<svg/);
  assert.match(html, /aria-label="Маленький штучний графік/);
  assert.match(html, /Без підключень до бірж|без підключень до бірж/);
  assert.doesNotMatch(html, /<canvas|chartWrap|type="range"|BTCUSDT|Binance|Bybit/);
  assert.match(previewSource, /maxWidth: '420px'/);
  const css = source('../src/components/hookchart/integration.css');
  assert.match(css, /hookchart-mini-preview/);
  assert.match(css, /pointer-events:none/);
});

test('mini preview never runs trading engine, market polling or gesture editing', () => {
  assert.match(previewSource, /createSyntheticPreviewCandles\(560\)/);
  assert.doesNotMatch(previewSource,
    /from '\.\/engine'|TradingViewChart|ChartTimeAxis|fetchDirectKlines|directExchangeClient|new WebSocket|ResizeObserver|setInterval|setTimeout|fetch\s*\(|onGesture|onPointerDown|onWheel|onChange=/);
  assert.match(settingsSource, /<HookChartVisualPreview/);
  assert.match(settingsSource, /profile=\{selectedProfile\}/);
  assert.match(settingsSource, /Компактний перегляд масштабу/);
  assert.doesNotMatch(settingsSource, /onViewportGesture=\{onGesture\}/);
});

test('profile can only be edited with sliders below the fixed mini preview', () => {
  const editor = settingsSource.slice(settingsSource.indexOf('function VisualProfileEditor'),
    settingsSource.indexOf('export function OriginalHookChartSettings'));
  const index = editor.indexOf('<HookChartVisualPreview');
  assert.ok(index > 0);
  const rest = editor.slice(index);
  assert.match(rest, /aria-label="Кількість видимих свічок"/);
  assert.match(rest, /aria-label="Вертикальний зум"/);
  assert.match(rest, /aria-label="Відступ праворуч у барах"/);
  assert.match(rest, /Автоматичний масштаб ціни/);
  assert.ok(rest.indexOf('Кількість видимих свічок') > rest.indexOf('<HookChartVisualPreview'));
  assert.doesNotMatch(rest.slice(0, rest.indexOf('<\/HookChartVisualPreview>')), /onChange=/);
});

test('synthetic candles are deterministic, valid and do not depend on real prices', () => {
  const a = createSyntheticPreviewCandles(560);
  const b = createSyntheticPreviewCandles(560);
  assert.deepEqual(a, b);
  assert.equal(a.length, 560);
  assert.ok(a.every(c => Number.isFinite(c.o) && Number.isFinite(c.c)
    && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c) && c.v >= 0));
  assert.ok(a.every((c, i) => i === 0 || c.t - a[i - 1].t === 900000));
});

test('sliders visibly alter candle count and right-gap description without fetching', () => {
  const small = renderToStaticMarkup(React.createElement(HookChartVisualPreview, {
    profile: { ...base, visibleBars: 40, rightGapBars: 8 },
  }));
  const big = renderToStaticMarkup(React.createElement(HookChartVisualPreview, {
    profile: { ...base, visibleBars: 210, rightGapBars: 30 },
  }));
  assert.match(small, /40 видимих барів/);
  assert.match(big, /210 видимих барів/);
  assert.match(small, /8 бар\./);
  assert.match(big, /30 бар\./);
  assert.notEqual(small, big);
});

test('Replay and real HookChart remain independent of the lightweight settings preview', () => {
  const replay = source('../src/components/replay/ReplayChart.tsx');
  const engine = source('../src/components/hookchart/engine.tsx');
  assert.doesNotMatch(replay, /HookChartVisualPreview|syntheticPreviewCandles/);
  assert.doesNotMatch(engine, /syntheticPreviewCandles/);
  assert.match(engine, /visualProfileKey/);
});
