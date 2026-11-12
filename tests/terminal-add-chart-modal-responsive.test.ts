import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/components/terminal/AddChartModal.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/terminal/addChartModal.css', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

test('Terminal coin picker renders in body portal, closes on Escape, and locks background scrolling', () => {
  assert.match(source, /import \{ createPortal \} from 'react-dom'/);
  assert.match(source, /return createPortal\(/);
  assert.match(source, /document\.body/);
  assert.match(source, /fixed inset-0 z-\[260\]/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby="terminal-add-chart-title"/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /document\.body\.style\.overflow = originalBody/);
});

test('Terminal coin picker has bounded viewport layout and scrollable filters/coins', () => {
  assert.match(entry, /import '\.\/components\/terminal\/addChartModal\.css'/);
  assert.doesNotMatch(source, /import ['"].*\.css['"]/);
  assert.match(source, /terminal-add-chart-modal flex w-full min-w-0/);
  assert.match(source, /terminal-add-chart-body flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden/);
  assert.match(source, /terminal-add-chart-filters min-h-0 min-w-0 shrink-0/);
  assert.match(source, /terminal-add-chart-list min-h-0 min-w-0 flex-1/);
  assert.match(css, /height: min\(92dvh, 900px\)/);
  assert.match(css, /max-height: calc\(100dvh - 16px\)/);
  assert.match(css, /@media \(max-width: 580px\)/);
  assert.match(css, /@media \(max-height: 540px\)/);
  assert.match(css, /overflow-y: auto/);
});

test('Terminal coin rows wrap, core filters and add actions remain wired', () => {
  assert.doesNotMatch(source, /autoFocus/);
  assert.match(source, /terminal-add-chart-coin-row group flex min-w-0/);
  assert.match(source, /terminal-add-chart-coin-action flex min-w-0 shrink-0/);
  assert.match(source, /setSelectedTimeframe\(tf\)/);
  assert.match(source, /setSelectedMarket\('futures'\)/);
  assert.match(source, /setSelectedExchange\('binance'\)/);
  assert.match(source, /onAddChart\(coin, selectedTimeframe, firstFormation\?\.id\)/);
  assert.match(source, /setDisplayCount\(\(prev\) => prev \+ 80\)/);
});
