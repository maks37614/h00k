import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/components/SurveillancePage.tsx', import.meta.url), 'utf8');
const topBar = source.slice(
  source.indexOf('{/* Top Header & 24/7 Engine Status Bar'),
  source.indexOf('{/* SECTION: Останні події нагляду'),
);

test('surveillance header uses the requested short title and status label', () => {
  assert.match(topBar, />Моніторинг<\/h1>/);
  assert.match(topBar, /\bLive\s*<\/span>/);
  assert.doesNotMatch(topBar, />24\/7 Моніторинг<\/h1>|LIVE ENGINE/);
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
  assert.match(topBar, /aria-label="Інформація про моніторинг"/);
  assert.match(topBar, /onMouseEnter=\{\(\) => setIsMonitoringHelpOpen\(true\)\}/);
  assert.match(topBar, /onFocus=\{\(\) => setIsMonitoringHelpOpen\(true\)\}/);
  assert.match(topBar, /onClick=\{\(\) => setIsMonitoringHelpOpen\(true\)\}/);
  assert.match(topBar, /onBlur=\{\(\) => setIsMonitoringHelpOpen\(false\)\}/);
  assert.match(topBar, /role="tooltip"/);
  assert.match(topBar, /aria-describedby=\{isMonitoringHelpOpen \? 'surveillance-monitoring-help' : undefined\}/);
  assert.doesNotMatch(topBar, /<p className="text-xs text-slate-400">\s*Комплексний моніторинг/);
});
