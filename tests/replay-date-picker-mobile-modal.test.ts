import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getReplayPresetDate, processCandlesForCutoff } from '../src/utils/replayService';

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
  assert.match(toolbar, /min-h-0 min-w-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto overscroll-contain/);
  assert.match(toolbar, /grid grid-cols-2 gap-2 min-\[380px\]:grid-cols-3/);
  assert.match(toolbar, /block w-full min-w-0 max-w-full/);
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

test('Replay quick dates add Today, 1 day ago and 5 days ago before older presets', () => {
  const expected = [
    "{ label: 'Сьогодні', days: 0 }",
    "{ label: '1 день тому', days: 1 }",
    "{ label: '5 днів тому', days: 5 }",
    "{ label: '14 днів тому', days: 14 }",
  ];
  let lastOffset = -1;
  for (const label of expected) {
    const offset = toolbar.indexOf(label);
    assert.ok(offset > lastOffset, 'Missing or out-of-order preset: ' + label);
    lastOffset = offset;
  }
  assert.match(toolbar, /onSelectHistoricalDate\(getReplayPresetDate\(days\)\)/);
});

test('Replay presets target local calendar day midnight, even across month boundaries', () => {
  const now = new Date(2026, 10, 12, 1, 33, 52);
  for (const days of [0, 1, 5, 14, 30, 60, 90, 180, 365]) {
    const expected = new Date(now);
    expected.setDate(expected.getDate() - days);
    expected.setHours(0, 0, 0, 0);
    const actual = getReplayPresetDate(days, now);
    assert.equal(actual.getTime(), expected.getTime());
    assert.equal(actual.getHours(), 0);
    assert.equal(actual.getMinutes(), 0);
  }
  assert.equal(getReplayPresetDate(0, now).getDate(), 12);
  assert.equal(getReplayPresetDate(1, now).getDate(), 11);
  assert.equal(getReplayPresetDate(5, now).getDate(), 7);
});

test('Near-live replay dates do not rewind 30 candles when future data is unavailable', () => {
  const now = new Date(2026, 10, 12, 1, 33, 0).getTime();
  const oneHour = 60 * 60 * 1000;
  const beginning = now - 281 * oneHour;
  const candles = Array.from({ length: 282 }, (_, n) => ({
    time: Math.floor((beginning + n * oneHour) / 1000),
    open: 10, high: 11, low: 9, close: 10, volume: 1,
  }));
  const today = getReplayPresetDate(0, new Date(now)).getTime();
  const recent = processCandlesForCutoff(candles, today, '1h', now);
  const dateCutoff = candles.reduce((index, candle, i) => candle.time * 1000 <= today ? i : index, -1);
  assert.equal(recent.cutoffIndex, dateCutoff);
  const beyondLast = processCandlesForCutoff(candles, beginning - 30 * oneHour, '1h', now);
  assert.ok(beyondLast.cutoffIndex < candles.length - 1);
});
