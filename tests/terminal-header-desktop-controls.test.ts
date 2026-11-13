import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/components/TerminalPage.tsx', import.meta.url), 'utf8');
const header = source.slice(source.indexOf('{/* Block count, centered clock'), source.indexOf('</header>'));
const secondRow = header.slice(header.lastIndexOf('grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'));

test('wide Terminal header groups layouts and autoscale before timeframes, presets and plus after', () => {
  assert.match(secondRow, /contents lg:col-start-2 lg:row-start-1 lg:flex/);
  const layout = secondRow.indexOf('title="1 Графік (на весь екран)"');
  const autoScale = secondRow.indexOf('{renderAutoScaleButton()}');
  const timeframe = secondRow.indexOf('{/* Timeframe Selector */}');
  const presets = secondRow.indexOf('ref={presetsButtonRef}');
  const plus = secondRow.indexOf('aria-label="Додати графік"');
  assert.ok(layout !== -1 && layout < autoScale && autoScale < timeframe &&
    timeframe < presets && presets < plus);
  assert.match(secondRow, /Монет: \{terminalCoinCount\}/);
  assert.equal((secondRow.match(/title="4 Колонки"/g) || []).length, 1);
});

test('smaller Terminal layouts keep their original grid and autoscale position', () => {
  assert.match(header, /justify-self-start lg:hidden/);
  assert.match(header, /grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
  assert.match(secondRow, /className="contents lg:col-start-2/);
  assert.match(secondRow, /col-start-1 row-start-1/);
  assert.match(secondRow, /col-start-2 row-start-1/);
  assert.match(secondRow, /col-start-3 row-start-1/);
  assert.equal((header.match(/\{renderAutoScaleButton\(\)\}/g) || []).length, 2);
  assert.equal((source.match(/onClick=\{\(\) => setAutoScaleCharts\(enabled => !enabled\)\}/g) || []).length, 1);
});

test('layout presets, timeframes and add-chart actions retain their existing behavior', () => {
  for (const value of ['1x', '2x', '3x', '4x']) assert.match(secondRow, new RegExp(value));
  assert.match(secondRow, /handleApplyGlobalTimeframe\(tf\)/);
  assert.match(secondRow, /setShowCoinPresets\(true\)/);
  assert.match(secondRow, /setIsAddModalOpen\(true\)/);
  assert.match(source, /aria-label="Автоматичний масштаб свічок усіх графіків"/);
  assert.match(secondRow, /ref=\{presetsButtonRef\}/);
});
