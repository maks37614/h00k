import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SurveillanceFieldDropdown } from '../src/components/SurveillanceFieldDropdown';

const pageSource = readFileSync(new URL('../src/components/SurveillancePage.tsx', import.meta.url), 'utf8');
const dropdownSource = readFileSync(new URL('../src/components/SurveillanceFieldDropdown.tsx', import.meta.url), 'utf8');
const form = pageSource.slice(
  pageSource.indexOf('{/* Exchange and Market selectors */}'),
  pageSource.indexOf('{/* Coin Input / Select */}'),
);

test('only Exchange and Market selectors use the new dark menu inside add coin modal', () => {
  assert.ok(form.length > 0, 'coin form must exist');
  assert.equal((form.match(/<SurveillanceFieldDropdown/g) || []).length, 2);
  assert.doesNotMatch(form, /<select|<option/);
  assert.match(form, /value=\{selectedExchange\}[\s\S]*?options=\{SURVEILLANCE_EXCHANGES\}[\s\S]*?onChange=\{setSelectedExchange\}/);
  assert.match(form, /value=\{selectedMarketType\}[\s\S]*?options=\{SURVEILLANCE_MARKETS\}[\s\S]*?onChange=\{setSelectedMarketType\}/);
  assert.match(pageSource, /value: 'binance', label: 'Binance'/);
  assert.match(pageSource, /value: 'bybit', label: 'Bybit'/);
  assert.match(pageSource, /value: 'futures', label: 'Futures \/ Linear'/);
  assert.match(pageSource, /value: 'spot', label: 'Spot'/);
});

test('dark dropdown trigger is labeled and keeps selected value visible', () => {
  const html = renderToStaticMarkup(React.createElement(SurveillanceFieldDropdown, {
    id: 'surveillance-exchange',
    labelId: 'surveillance-exchange-label',
    value: 'bybit',
    options: [{ value: 'binance', label: 'Binance' }, { value: 'bybit', label: 'Bybit' }],
    onChange: () => {},
  }));
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-labelledby="surveillance-exchange-label surveillance-exchange-value"/);
  assert.match(html, /Bybit/);
  assert.match(html, /bg-slate-950/);
  assert.doesNotMatch(html, /<select/);
});

test('opened popup matches screenshot, does not clip in a scrolling modal and supports keyboard', () => {
  assert.match(dropdownSource, /createPortal\(/);
  assert.match(dropdownSource, /document\.body/);
  assert.match(dropdownSource, /role="listbox"/);
  assert.match(dropdownSource, /role="option"/);
  assert.match(dropdownSource, /aria-selected=\{option\.value === value\}/);
  assert.match(dropdownSource, /<Check className="h-4 w-4/);
  assert.match(dropdownSource, /bg-slate-800/);
  assert.match(dropdownSource, /text-cyan-300/);
  assert.match(dropdownSource, /min-h-11/);
  assert.match(dropdownSource, /window\.visualViewport/);
  assert.match(dropdownSource, /viewportLeft \+ viewportWidth - width - margin/);
  assert.match(dropdownSource, /event\.key === 'Escape'/);
  assert.match(dropdownSource, /event\.key === 'ArrowDown'/);
  assert.match(dropdownSource, /event\.key === 'ArrowUp'/);
  assert.match(dropdownSource, /event\.key === 'Enter'/);
  assert.match(dropdownSource, /document\.addEventListener\('pointerdown', onOutside\)/);
});


test('ticker input prevents iPhone Safari autofocus zoom while remaining accessible', () => {
  const input = pageSource.slice(
    pageSource.indexOf('id="surveillance-symbol-input"'),
    pageSource.indexOf('{/* Breakout Confirmation Modes'),
  );
  assert.match(input, /type="text"/);
  assert.match(input, /text-base sm:text-sm/);
  assert.doesNotMatch(input, /className="[^"]*text-xs/);
  assert.match(input, /autoCapitalize="characters"/);
  assert.match(input, /autoComplete="off"/);
  assert.match(input, /spellCheck=\{false\}/);
  assert.match(input, /min-h-11 w-full min-w-0/);
  assert.match(pageSource, /htmlFor="surveillance-symbol-input"/);
  // Do not disable the user's browser pinch zoom to work around this issue.
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /width=device-width, initial-scale=1.0/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
});

test('add-coin modal stays scrollable and follows mobile visualViewport when keyboard opens', () => {
  assert.match(pageSource, /const \[addModalViewport, setAddModalViewport\] = useState/);
  assert.match(pageSource, /window\.visualViewport\?\.addEventListener\('resize', updateViewport\)/);
  assert.match(pageSource, /window\.visualViewport\?\.addEventListener\('scroll', updateViewport\)/);
  assert.match(pageSource, /window\.visualViewport\?\.removeEventListener\('resize', updateViewport\)/);
  assert.match(pageSource, /width: addModalViewport\.width/);
  assert.match(pageSource, /height: addModalViewport\.height/);
  assert.match(pageSource, /Math\.min\(addModalViewport\.height \* 0\.92, addModalViewport\.height - 16\)/);
  assert.match(pageSource, /min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain/);
  assert.match(pageSource, /shrink-0 p-3 sm:p-4 border-t/);
  assert.match(form, /grid grid-cols-1 min-\[380px\]:grid-cols-2/);
  assert.match(form, /<SurveillanceFieldDropdown<ExchangeId>/);
  assert.match(form, /<SurveillanceFieldDropdown<MarketType>/);
});
