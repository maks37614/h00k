import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { OriginalHookChartSettings, normalizeOriginalHookChartPreferences } from '../src/components/hookchart/OriginalHookChartSettings';

test('unimplemented settings are visibly unavailable while operational chart controls stay enabled', () => {
  const prefs = normalizeOriginalHookChartPreferences({ rBtcTf: '4h', rBtcCandles: 250, duplicateCrosshair: true });
  const html = renderToStaticMarkup(React.createElement(OriginalHookChartSettings, {
    open: true, embedded: true, prefs, onChange() {}, onApplyStrategy() {}, onClose() {},
  }));
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const unavailable = [...document.querySelectorAll('fieldset[disabled]')];
  assert.equal(unavailable.length, 14);
  for (const fieldset of unavailable) {
    assert.match(fieldset.closest('.settingRow')!.textContent!, /Ще не реалізовано/);
    for (const control of fieldset.querySelectorAll('input,button,select')) assert.equal(control.matches(':disabled'), true);
  }
  for (const label of ['Long (L)', 'Short (S)', 'Ліквідації на графіку']) {
    const control = document.querySelector(`input[aria-label="${label}"]`)!;
    assert.ok(control);
    assert.equal(control.matches(':disabled'), false);
  }
  const correlation = unavailable.find(fieldset => fieldset.closest('section')!.textContent!.includes('колонка rBTC') && fieldset.querySelector('input'))!;
  assert.equal((correlation.querySelector('input') as HTMLInputElement).value, '250');
  assert.equal(prefs.rBtcTf, '4h', 'existing profile values remain available for future implementation');
  dom.window.close();
});
