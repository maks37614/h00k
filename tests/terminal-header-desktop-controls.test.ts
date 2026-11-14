import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/components/TerminalPage.tsx', import.meta.url), 'utf8');
const header = source.slice(source.indexOf('{/* Mobile has two control rows'), source.indexOf('</header>'));
const secondRow = header.slice(header.lastIndexOf('grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'));

test('desktop terminal header uses one row without changing the mobile two-row grid', () => {
  // Each original mobile row stays a three-column grid.
  assert.equal((header.match(/grid-cols-\\[minmax\\(0,1fr\\)_auto_minmax\\(0,1fr\\)\\]/g) ?? []).length, 2);
  // On lg+, both row wrappers become display: contents; all five groups share
  // the same desktop grid row instead of occupying separate vertical lines.
  assert.match(header, /lg:grid lg:grid-cols-\\[minmax\\(0,1fr\\)_auto_auto_auto_minmax\\(0,1fr\\)\\] lg:items-center/);
  assert.equal((header.match(/lg:contents/g) ?? []).length, 2);
  assert.match(header, /col-start-2 row-start-1 justify-self-center lg:col-start-2 lg:row-start-1/);
  assert.match(header, /col-start-3 row-start-1 flex shrink-0 items-center justify-self-end[^"]*lg:col-start-5 lg:row-start-1/);
  assert.match(secondRow, /col-start-1 row-start-1 flex[^"]*lg:col-start-1 lg:row-start-1/);
  assert.match(secondRow, /col-start-2 row-start-1 flex[^"]*lg:col-start-3 lg:row-start-1/);
  assert.match(secondRow, /col-start-3 row-start-1 flex[^"]*lg:col-start-4 lg:row-start-1/);
});

test('on wide screens autoscale comes before 1x–4x on the left, presets and plus after timeframe', () => {
  const counter = secondRow.indexOf('Монет: {terminalCoinCount}');
  const auto = secondRow.indexOf('{renderAutoScaleButton()}');
  const one = secondRow.indexOf('title="1 колонка (зберегти всі графіки)"');
  const four = secondRow.indexOf('title="4 Колонки"');
  const timeframe = secondRow.indexOf('{/* Timeframe Selector */}');
  const preset = secondRow.indexOf('ref={presetsButtonRef}');
  const add = secondRow.indexOf('aria-label="Додати графік"');
  assert.ok(counter >= 0 && counter < auto && auto < one && one < four &&
    four < timeframe && timeframe < preset && preset < add);
  assert.match(secondRow, /hidden shrink-0 items-center lg:ml-auto lg:flex/);
  assert.match(secondRow, /col-start-3 row-start-1 flex items-center justify-self-start/);
  assert.equal((secondRow.match(/title="4 Колонки"/g) ?? []).length, 1);
  const layouts = secondRow.slice(secondRow.indexOf('title="1 колонка (зберегти всі графіки)"'), timeframe);
  assert.doesNotMatch(layouts, /setBlocks\(/, 'column buttons must never discard open charts');
  assert.doesNotMatch(layouts, /handleApplyPreset\(/, 'column buttons must not replace selected coins');
});

test('top-right shortcuts are anchored to the right and bordered on desktop', () => {
  assert.match(header, /col-start-3 row-start-1 flex shrink-0 items-center justify-self-end/);
  for (const label of [
    'Створити сповіщення в Telegram', 'Надіслати в обраний термінал',
    'Налаштування робочого простору', 'На весь екран браузера', 'Закрити термінал',
  ]) assert.ok(header.includes(label));
  assert.equal((header.match(/lg:h-8 lg:w-8 lg:rounded-lg lg:border/g) ?? []).length, 5);
  assert.match(header, /lg:border-sky-500\/35/);
  assert.match(header, /lg:border-amber-500\/35/);
});

test('smaller screens keep the original positions and all actions remain connected', () => {
  assert.match(header, /justify-self-start lg:hidden/);
  assert.equal((header.match(/\{renderAutoScaleButton\(\)\}/g) ?? []).length, 2);
  assert.equal((source.match(/onClick=\{\(\) => setAutoScaleCharts\(enabled => !enabled\)\}/g) ?? []).length, 1);
  assert.match(secondRow, /col-start-1 row-start-1/);
  assert.match(secondRow, /col-start-2 row-start-1/);
  assert.match(secondRow, /col-start-3 row-start-1/);
  assert.match(secondRow, /handleApplyGlobalTimeframe\(tf\)/);
  assert.match(secondRow, /setShowCoinPresets\(true\)/);
  assert.match(secondRow, /setIsAddModalOpen\(true\)/);
  assert.match(header, /onClick=\{onReturnToPatterns\}/);
});
