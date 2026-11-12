import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const archive = readFileSync(new URL('../src/components/ArchiveModal.tsx', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('archive coin search is large enough on iPhone not to trigger Safari automatic input zoom', () => {
  const input = archive.match(/<input\s+type="text"\s+value=\{searchQuery\}[\s\S]*?\/>/)?.[0];
  assert.ok(input, 'The archive search input still exists');
  assert.match(input, /onChange=\{\(e\) => setSearchQuery\(e\.target\.value\)\}/);
  assert.match(input, /text-base sm:text-xs/, 'mobile input uses 16px / 1rem font size');
  assert.match(input, /focus:border-purple-500\/60/);
  assert.match(input, /touch-manipulation/);
});

test('archive remains scrollable with the iPhone keyboard and pinch zoom is not disabled', () => {
  assert.match(archive, /max-h-\[92dvh\]/);
  assert.match(archive, /min-h-0 flex-1 overflow-y-auto overscroll-contain/);
  assert.match(index, /width=device-width, initial-scale=1\.0/);
  assert.doesNotMatch(index, /user-scalable=no|maximum-scale=1/);
});
