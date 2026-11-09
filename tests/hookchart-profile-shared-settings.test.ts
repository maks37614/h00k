import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mergeHookPreferences } from '../src/utils/hookchartData';
import { OriginalHookChartSettings, normalizeOriginalHookChartPreferences } from '../src/components/hookchart/OriginalHookChartSettings';
import { STRATEGY_PRESETS, strategyPreferencePatch, strategyOiDelta, evaluateStrategy } from '../src/components/hookchart/strategyEngine';
import type { HookChartPreferences } from '../src/types';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('one shared chart editor can render inside the profile without a nested dialog', () => {
  const html = renderToStaticMarkup(React.createElement(OriginalHookChartSettings, {
    open: true,
    embedded: true,
    prefs: normalizeOriginalHookChartPreferences(),
    onChange: () => {},
    onApplyStrategy: () => {},
    onClose: () => {},
  }));
  assert.match(html, /embeddedSettingsBackdrop/);
  assert.match(html, /role="region"/);
  assert.doesNotMatch(html, /aria-modal="true"/);
  assert.match(html, /Налаштування графіка/);
  assert.match(html, /Стратегії/);
  assert.match(html, /Гарячі клавіші/);
  assert.match(html, /Фактична кількість свічок залежить від біржі/);
  assert.doesNotMatch(html, /Завантажено:.*0/);
});

test('profile Graph tab mounts the same settings editor and saves profile deltas', () => {
  const modal = source('../src/components/UserProfileModal.tsx');
  const shared = source('../src/components/profile/ProfileHookChartSettings.tsx');
  assert.match(modal, /Графік/);
  assert.match(modal, /activeProfileSection === 'chart'/);
  assert.match(modal, /<ProfileHookChartSettings/);
  assert.match(shared, /<OriginalHookChartSettings/);
  assert.match(shared, /embedded/);
  assert.match(shared, /hookChartPreferences: delta/);
  assert.match(shared, /setTimeout\(flush, 500\)/);
  assert.match(shared, /siteLanguageAtSelection/);
});

test('strategy selection sends exactly the same settings patch from profile and chart', () => {
  const ids = STRATEGY_PRESETS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, 'strategy identifiers must be unique');
  assert.ok(ids.length >= 10, 'strategies are available');
  assert.deepEqual(strategyPreferencePatch(''), { strategyId: '' });
  assert.equal(strategyPreferencePatch('not-a-strategy'), null);
  for (const preset of STRATEGY_PRESETS) {
    const patch = strategyPreferencePatch(preset.id)!;
    assert.equal(patch.strategyId, preset.id);
    for (const [key, value] of Object.entries(preset.settings)) {
      assert.deepEqual((patch as unknown as Record<string, unknown>)[key], value, `${preset.id}: ${key}`);
    }
    assert.ok(preset.requiredTfs.length > 0, `${preset.id} has timeframe prerequisites`);
  }
  const profile = source('../src/components/profile/ProfileHookChartSettings.tsx');
  const canvas = source('../src/components/hookchart/HookChartCanvas.tsx');
  assert.match(profile, /strategyPreferencePatch\(id\)/);
  assert.match(canvas, /strategyPreferencePatch\(id\)/);
});

test('parallel profile writes merge independent chart preferences without deleting drawings', () => {
  const old: HookChartPreferences = { strategyId: 'impulse_15m', maxChartCandles: 500, drawings: { 'shared:BTCUSDT': [{ id:'a', type:'trend', pts:[] }] } };
  const withProfile = mergeHookPreferences(old, { maxChartCandles: 2000 });
  assert.equal(withProfile.strategyId, 'impulse_15m');
  assert.equal(withProfile.maxChartCandles, 2000);
  assert.equal(withProfile.drawings?.['shared:BTCUSDT']?.[0].id, 'a');
  const withChart = mergeHookPreferences(withProfile, { strategyId: 'breakout_early' });
  assert.equal(withChart.maxChartCandles, 2000);
  assert.equal(withChart.strategyId, 'breakout_early');
});

test('OI comparison requires actual 1h/12h history; missing samples cannot fake a full window', () => {
  const hour = 60*60*1000;
  const rows = [{t:hour, v:100},{t:2*hour, v:110},{t:3*hour, v:120}];
  assert.equal(strategyOiDelta(rows, hour), (120/110-1)*100);
  assert.ok(Math.abs(strategyOiDelta(rows, 2*hour) - 20) < 1e-10,
    'two-hour OI comparison is approximately 20%, within floating-point precision');
  assert.ok(Number.isNaN(strategyOiDelta(rows, 12*hour)));
  assert.ok(Number.isNaN(strategyOiDelta(rows.slice(0,1), hour)));
});

test('all preset evaluators tolerate missing market data without emitting imaginary events', () => {
  for (const preset of STRATEGY_PRESETS) {
    const result = evaluateStrategy(preset, {
      series:{}, chartCandles:[], levels:[], densities:[],
      book:{ a:[], b:[] }, oiHistory:[], fundingHistory:[],
      fundingRate:NaN, currentPrice:100, cascadeRisk:0,
    });
    assert.equal(result.presetId,preset.id);
    assert.deepEqual(result.events,[]);
  }
});
