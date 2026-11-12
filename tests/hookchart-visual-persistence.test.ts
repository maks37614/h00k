import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { UserProfile } from '../src/types';
import { mergeProfileUpdate } from '../src/utils/hookchartData';
import { normalizeOriginalHookChartPreferences } from '../src/components/hookchart/OriginalHookChartSettings';
import { captureVisualProfile, getVisualProfile, patchVisualProfile } from '../src/components/hookchart/visualProfiles';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Save scale preview writes through editor and profile persistence path', () => {
  const preview = read('../src/components/hookchart/HookChartVisualPreview.tsx');
  const editor = read('../src/components/hookchart/OriginalHookChartSettings.tsx');
  const profile = read('../src/components/profile/ProfileHookChartSettings.tsx');
  const chart = read('../src/components/hookchart/HookChartCanvas.tsx');
  assert.match(preview, /changeRef\.current\(\{ \.\.\.profileRef\.current \}\)/);
  assert.match(preview, /Зберегти масштаб із цього графіка/);
  assert.match(preview, /saveStatus === 'saved'/);
  assert.match(editor, /onChange=\{onProfileChange\}/);
  assert.match(editor, /set\('visualProfiles', patchVisualProfile\(/);
  assert.match(profile, /writerRef\.current\(\{ hookChartPreferences: delta \}\)/);
  assert.match(profile, /Збережено у профілі/);
  assert.match(chart, /queueSave\(delta\)/);
  assert.match(chart, /saveRef\.current\(\{ hookChartPreferences: delta \}\)/);
});

test('captured manual scale and extended gap survive account save plus rehydration', () => {
  const key = 'terminalCompact:mobile';
  const other = 'screenerFull:desktop';
  const sourceProfiles = patchVisualProfile(undefined, other, {
    visibleBars: 85, verticalZoom: 1.4, rightGapBars: 10,
  });
  const profileBase = getVisualProfile({ visualProfiles: sourceProfiles }, 'terminalCompact', 'mobile');
  const chosen = { ...profileBase, visibleBars: 144, verticalZoom: 0.25, rightGapBars: 400 };
  const previewView = { barWidth: 1, rightOffset: 0, autoY: false, manualRange: 40, yZoom: .25 };
  // Capture gesture scale, preserving the independently controlled right margin.
  const captured = captureVisualProfile(chosen, 544, previewView, 20);
  assert.equal(captured.visibleBars, 144);
  assert.equal(captured.verticalZoom, 0.5);
  assert.equal(captured.autoPriceScale, false);
  assert.equal(captured.rightGapBars, 400);
  const savedProfiles = patchVisualProfile(sourceProfiles, key, captured);
  const account = { uid: 'test-user', displayName: 'Tester', email: 'test@example.com',
    hookChartPreferences: { visualProfiles: sourceProfiles } } as UserProfile;
  const updated = mergeProfileUpdate(account, { hookChartPreferences: { visualProfiles: savedProfiles } });
  const reloaded = normalizeOriginalHookChartPreferences(
    JSON.parse(JSON.stringify(updated.hookChartPreferences)),
  );
  const restored = getVisualProfile(reloaded, 'terminalCompact', 'mobile');
  assert.deepEqual(restored, captured);
  assert.equal(getVisualProfile(reloaded, 'screenerFull', 'desktop').visibleBars, 85);
});

test('synthetic gesture changes are sent directly to saved visual profile without a Save click', () => {
  const preview = read('../src/components/hookchart/HookChartVisualPreview.tsx');
  const live = read('../src/components/hookchart/HookChartCanvas.tsx');
  assert.match(preview, /profileRef\.current = next;\s*setEdited\(true\);\s*changeRef\.current\(next\)/);
  assert.match(preview, /demoDragProfile\(/);
  assert.match(preview, /demoPinchProfile\(/);
  assert.match(live, /viewport\.barWidth\) - rightPaddingBars/);
});
