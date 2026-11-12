import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MonitoringIcon, MonitoringMenuIcon } from '../src/components/MonitoringIcon';

const source = readFileSync(new URL('../src/components/SurveillancePage.tsx', import.meta.url), 'utf8');
const topBar = source.slice(
  source.indexOf('{/* Top Header & 24/7 Engine Status Bar'),
  source.indexOf('{/* SECTION: Останні події нагляду'),
);

test('surveillance header uses the requested short title and status label', () => {
  assert.match(topBar, />Стеження за монетами<\/h1>/);
  assert.match(topBar, /\bLive\s*<\/span>/);
  assert.doesNotMatch(topBar, />24\/7 Моніторинг<\/h1>|>Моніторинг<\/h1>|LIVE ENGINE/);
});

test('watched count is immediately after the refresh control in the header action group', () => {
  assert.match(topBar, /className="flex shrink-0 items-center gap-2">\s*<button[\s\S]*?title="Оновити дані"[\s\S]*?<\/button>\s*<div aria-label=\{`Стеження: \$\{activeCount\} монет`\}/);
  assert.equal((topBar.match(/\{activeCount\} МОНЕТ/g) || []).length, 1);
  assert.doesNotMatch(topBar, /pt-3 border-t border-slate-800\/80 font-mono/);
});

test('monitoring question-mark tooltip shows the full description on hover, focus and tap', () => {
  const description = 'Комплексний моніторинг ринку на серверах h00k.top: Local Order Book, Multi-Timeframe структура, рівні, щільності та Telegram алерти';
  assert.equal(topBar.split(description).length - 1, 1, 'description must live only in the tooltip');
  assert.match(topBar, /<HelpCircle className="h-4 w-4" aria-hidden="true" \/>/);
  assert.match(topBar, /aria-label="Інформація про стеження за монетами"/);
  assert.match(topBar, /onMouseEnter=\{\(\) => setIsMonitoringHelpOpen\(true\)\}/);
  assert.match(topBar, /onFocus=\{\(\) => setIsMonitoringHelpOpen\(true\)\}/);
  assert.match(topBar, /onClick=\{\(\) => setIsMonitoringHelpOpen\(true\)\}/);
  assert.match(topBar, /onBlur=\{\(\) => setIsMonitoringHelpOpen\(false\)\}/);
  assert.match(topBar, /role="tooltip"/);
  assert.match(topBar, /aria-describedby=\{isMonitoringHelpOpen \? 'surveillance-monitoring-help' : undefined\}/);
  assert.doesNotMatch(topBar, /<p className="text-xs text-slate-400">\s*Комплексний моніторинг/);
});

test('monitoring uses the approved high-resolution inline SVG emblem', () => {
  assert.match(topBar, /<MonitoringIcon className="w-14 h-14" \/>/);
  const markup = renderToStaticMarkup(React.createElement(MonitoringIcon, { className: 'w-14 h-14' }));
  assert.match(markup, /<svg[^>]+viewBox="0 0 100 100"/);
  assert.match(markup, /24\/7/);
  assert.match(markup, /<linearGradient/);
  assert.match(markup, /<feGaussianBlur/);
  assert.match(markup, /<circle/);
  assert.match(markup, /<rect/);
  assert.match(markup, /<text/);
  assert.doesNotMatch(markup, /monitoring-24-7\.png|mask-image|maskImage/);
  assert.match(markup, /aria-hidden="true"/);
});

test('monitoring menu icon remains unchanged and renders independently', () => {
  const markup = renderToStaticMarkup(React.createElement(MonitoringMenuIcon));
  assert.match(markup, /viewBox="0 0 24 24"/);
  assert.match(markup, /<svg/);
});


const eventsHeader = source.slice(
  source.indexOf('{/* Unified events header:'),
  source.indexOf('{/* Panel Content (Expandable) */}'),
);

test('coin watching heading is emphasized without changing monitoring controls', () => {
  assert.doesNotMatch(topBar, /border-b border-cyan-400\/60/);
  assert.match(topBar, /bg-gradient-to-r from-white via-cyan-100 to-sky-300/);
  assert.match(topBar, /<MonitoringIcon className="w-14 h-14" \/>/);
  assert.match(topBar, /title="Оновити дані"/);
});

test('event feed combines title, count, description and collapse into one header', () => {
  assert.ok(eventsHeader.length > 0);
  assert.match(eventsHeader, /grid grid-cols-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.match(eventsHeader, /Останні події нагляду/);
  assert.match(eventsHeader, /\{allEvents\.length\} \{allEvents\.length === 1/);
  assert.match(eventsHeader, /Хронологічний лог тестів рівнів, щільностей стакану, пробоїв, змін структури та сигналів сетапів/);
  assert.match(eventsHeader, /aria-expanded=\{isEventsExpanded\}/);
  assert.match(eventsHeader, /aria-controls="surveillance-events-panel"/);
  assert.match(eventsHeader, /'Згорнути' : 'Розгорнути'/);
  assert.doesNotMatch(eventsHeader, /<RefreshCw|title="Оновити події"|onClick=\{\(\) => refresh\(\)\}/);
  assert.match(source, /<div id="surveillance-events-panel" className="p-4 space-y-4">/);
});
