import test from 'node:test';
import assert from 'node:assert/strict';
import { SCREENER_VOLUME_CAPS, isVolumeWithinCap } from '../src/utils/screenerVolume';

test('screener volume options include intermediate tiers and stop at 50B', () => {
  const caps = SCREENER_VOLUME_CAPS.map(option => option.value);
  assert.equal(caps[0], 50_000);
  assert.equal(caps[1], 100_000);
  assert.ok(caps.includes(250_000));
  assert.ok(caps.includes(1_000_000));
  assert.ok(caps.includes(10_000_000_000));
  assert.equal(caps.at(-1), 50_000_000_000);
  assert.equal(SCREENER_VOLUME_CAPS.at(-1)?.label, 'До $50B');
  assert.equal(new Set(caps).size, caps.length);
  assert.ok(caps.every((cap, i) => i === 0 || cap > caps[i - 1]));
});

test('upper cap is inclusive, only excluding amounts above the selected threshold', () => {
  assert.equal(isVolumeWithinCap(49_999.99, 50_000), true);
  assert.equal(isVolumeWithinCap(50_000, 50_000), true);
  assert.equal(isVolumeWithinCap(50_000.01, 50_000), false);
  assert.equal(isVolumeWithinCap(99_999, 100_000), true);
  assert.equal(isVolumeWithinCap(100_001, 100_000), false);
});

test('unlimited is separate from the highest selectable 50B limit', () => {
  assert.equal(isVolumeWithinCap(0, 0), true);
  assert.equal(isVolumeWithinCap(15_000_000_000, 0), true);
  assert.equal(isVolumeWithinCap(2_000_000_000_000, 0), true);
  assert.equal(isVolumeWithinCap(50_000_000_000, 50_000_000_000), true);
  assert.equal(isVolumeWithinCap(50_000_000_001, 50_000_000_000), false);
  assert.equal(isVolumeWithinCap(2_000_000_000_000, 50_000_000_000), false);
});
