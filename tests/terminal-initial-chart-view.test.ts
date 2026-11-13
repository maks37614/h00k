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
