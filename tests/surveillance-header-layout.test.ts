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
