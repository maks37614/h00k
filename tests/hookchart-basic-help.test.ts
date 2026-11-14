import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mainSettingHelpText } from '../src/components/hookchart/mainSettingsHelp';
import { OriginalHookChartSettings, normalizeOriginalHookChartPreferences } from '../src/components/hookchart/OriginalHookChartSettings';

const code = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('every Basic HookChart control has its own contextual explanation', () => {
  const source = code('../src/components/hookchart/OriginalHookChartSettings.tsx');
  const start = source.indexOf("{tab === 'main' ? <MainSettingsHelpContext.Provider");
  const end = source.indexOf("</MainSettingsHelpContext.Provider> : tab === 'chart'");
  assert.ok(start !== -1 && end > start, 'Basic controls must be wrapped in help context');
  const lines = source.slice(start, end).split('\n');
  let section = '';
  let controls = 0;
  for (const line of lines) {
    const heading = line.match(/<Section title="([^"]+)"/);
    if (heading) section = heading[1];
    const item = line.match(/<(Setting|SwitchRow|Choice|MultiChoice)(?:\s+unavailable)?\s+label="([^"]+)"/);
    if (!item) continue;
    controls += 1;
    const explanation = mainSettingHelpText(section, item[2]);
    assert.ok(explanation && explanation.length >= 35, `Missing explanation: ${section} / ${item[2]}`);
  }
  assert.equal(controls, 87, 'all currently available Basic settings must have explanatory help');
  assert.notEqual(mainSettingHelpText('Відносний об’єм (колонка VR)', 'Кількість свічок'),
    mainSettingHelpText('Кількість угод (лише Binance)', 'Кількість свічок'),
    'the same label must explain a different function depending on its section');
});

test('each Basic setting renders one small question-mark trigger, even when unavailable', () => {
  const html = renderToStaticMarkup(React.createElement(OriginalHookChartSettings, {
    open: true, embedded: true, prefs: normalizeOriginalHookChartPreferences(),
    onChange: () => {}, onApplyStrategy: () => {}, onClose: () => {},
  }));
  assert.equal((html.match(/aria-label="Пояснення: /g) || []).length, 87);
  assert.equal((html.match(/class="visualSettingHelp mainSettingHelp"/g) || []).length, 87);
  assert.match(html, /Пояснення: Зі сповіщень відкривати графіки в новому вікні/);
  assert.match(html, /Пояснення: Показувати колонку OI/);
  assert.match(html, /Пояснення: Кількість свічок Pavg/);
});

test('tooltips respond to hover, focus and tap without disturbing other HookChart tabs', () => {
  const source = code('../src/components/hookchart/OriginalHookChartSettings.tsx');
  const css = code('../src/components/hookchart/integration.css');
  assert.match(source, /onPointerEnter=\{event =>/);
  assert.match(source, /onPointerLeave=\{event =>/);
  assert.match(source, /onFocus=\{\(\) => setOpen\(true\)\}/);
  assert.match(source, /onClick=\{\(\) => setOpen\(true\)\}/);
  assert.match(source, /aria-describedby=\{open \? tooltipId : undefined\}/);
  assert.match(source, /if \(event\.key === 'Escape' && document\.querySelector\('\.hookchartVisualHelpPopover'\)\) return/);
  assert.match(css, /\.visualSettingHelp\.mainSettingHelp \.visualSettingHelpButton/);
  assert.match(css, /@media \(hover:none\) and \(pointer:coarse\)/);
  assert.match(css, /width:18px/);
  assert.match(css, /min-width:23px/);
  assert.doesNotMatch(source.slice(source.indexOf("tab === 'chart' ? ("), source.indexOf("tab === 'strategies' ? (")), /<MainSettingsHelpContext.Provider/);
});
