import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldShowGuestLanding } from '../src/utils/guestEntry';

test('new guests see a public introduction at root', () => {
  assert.equal(shouldShowGuestLanding('/', '', false), true);
  assert.equal(shouldShowGuestLanding('/', '#welcome', false), true);
  assert.equal(shouldShowGuestLanding('/welcome', '', false), true);
});
test('the original live screener and replay remain reachable by guests', () => {
  assert.equal(shouldShowGuestLanding('/', '#screener', false), false);
  assert.equal(shouldShowGuestLanding('/', '#replay', false), false);
});
test('signed-in users go directly to the workspace', () => {
  assert.equal(shouldShowGuestLanding('/', '', true), false);
  assert.equal(shouldShowGuestLanding('/welcome', '', true), true);
});
test('other route paths never render the marketing page', () => {
  assert.equal(shouldShowGuestLanding('/privacy', '', false), false);
  assert.equal(shouldShowGuestLanding('/terms', '', false), false);
  assert.equal(shouldShowGuestLanding('/api/health', '', false), false);
});
