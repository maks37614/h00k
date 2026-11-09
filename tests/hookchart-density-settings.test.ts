import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OriginalHookChartSettings, normalizeOriginalHookChartPreferences } from '../src/components/hookchart/OriginalHookChartSettings';

const noop = () => {};
test('full settings display this chart’s calculated AUTO sum instead of a saved manual sum', () => {
  for (const densityCut of [312, 45_678, 1_234_567]) {
    const html = renderToStaticMarkup(React.createElement(OriginalHookChartSettings, {
      open: true, densityCut,
      prefs: normalizeOriginalHookChartPreferences({ densityMode: 'auto', densityThreshold: 987_654 }),
      onChange: noop, onApplyStrategy: noop, onClose: noop,
    }));
    assert.match(html, new RegExp(`<input(?=[^>]*disabled)(?=[^>]*value="${densityCut}")[^>]*>`));
    assert.ok(!html.includes('value="987654"'));
  }
});

test('full settings retain the user’s exact manual floor when AUTO data changes', () => {
  const html = renderToStaticMarkup(React.createElement(OriginalHookChartSettings, {
    open: true, densityCut: 312,
    prefs: normalizeOriginalHookChartPreferences({ densityMode: 'manual', densityThreshold: 987_654 }),
    onChange: noop, onApplyStrategy: noop, onClose: noop,
  }));
  assert.match(html, /<input(?=[^>]*value="987654")(?![^>]*disabled)[^>]*>/);
});
