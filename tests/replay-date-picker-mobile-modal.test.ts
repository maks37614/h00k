import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const toolbar = readFileSync(new URL('../src/components/replay/ReplayToolbar.tsx', import.meta.url), 'utf8');

test('Replay historical date picker is rendered at body level above the chart', () => {
  assert.match(toolbar, /import \{ createPortal \} from 'react-dom'/);
  assert.match(toolbar, /isDatePickerOpen && typeof document !== 'undefined' && createPortal\(/);
  assert.match(toolbar, /document\.body\s*\n\s*\)\}/);
  assert.match(toolbar, /fixed inset-0 z-\[250\]/);
  assert.match(toolbar, /role="dialog"/);
  assert.match(toolbar, /aria-modal="true"/);
  assert.match(toolbar, /aria-labelledby="replay-date-picker-title"/);
});

test('Replay date modal fits short mobile viewports and keeps content scrollable', () => {
  assert.match(toolbar, /max-h-\[calc\(100dvh-16px\)\]/);
  assert.match(toolbar, /sm:max-h-\[calc\(100dvh-32px\)\]/);
  assert.match(toolbar, /min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain/);
  assert.match(toolbar, /shrink-0 items-center justify-between gap-3 border-b/);
  assert.match(toolbar, /shrink-0 items-center justify-end gap-2 border-t/);
  assert.match(toolbar, /document\.body\.style\.overflow = 'hidden'/);
  assert.match(toolbar, /document\.documentElement\.style\.overflow = 'hidden'/);
  assert.match(toolbar, /document\.body\.style\.overflow = bodyOverflow/);
  assert.match(toolbar, /document\.documentElement\.style\.overflow = htmlOverflow/);
  assert.match(toolbar, /event\.key === 'Escape'/);
});

test('Replay date picker preserves date choice actions and only changes date dialog', () => {
  assert.match(toolbar, /onClick=\{\(\) => handleApplyPresetDaysAgo\(item\.days\)\}/);
  assert.match(toolbar, /onClick=\{handleApplyCustomDate\}/);
  assert.match(toolbar, /onRandomHistoricalDate\(\)/);
  assert.match(toolbar, /onChange=\{\(event\) => setCustomDateTime\(event\.target\.value\)\}/);
  assert.match(toolbar, /isCoinModalOpen && \(/);
});
