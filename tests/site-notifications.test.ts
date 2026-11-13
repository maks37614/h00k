import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SITE_NOTIFICATIONS, ImpulseTracker, normalizeImpulseSymbol,
  normalizeSiteNotificationSettings, notificationEnabled,
  readNotificationItems, siteNotificationSettingsKey, siteNotificationStorageKey,
} from '../src/utils/siteNotifications';

test('notification categories have independent opt-out and a master disable', () => {
  const defaults = normalizeSiteNotificationSettings(null);
  assert.deepEqual(defaults, DEFAULT_SITE_NOTIFICATIONS);
  assert.equal(notificationEnabled(defaults, 'price'), true);
  assert.equal(notificationEnabled(defaults, 'formation'), true);
  assert.equal(notificationEnabled(defaults, 'impulse'), false);
  assert.equal(notificationEnabled(defaults, 'surveillance'), true);
  const disabled = normalizeSiteNotificationSettings({ ...defaults, enabled: false, impulses: true });
  for (const type of ['price', 'formation', 'impulse', 'surveillance'] as const)
    assert.equal(notificationEnabled(disabled, type), false);
  assert.equal(notificationEnabled({ ...defaults, price: false }, 'price'), false);
  assert.equal(notificationEnabled({ ...defaults, price: false }, 'formation'), true);
});

test('impulse symbol and threshold inputs are normalized and bounded', () => {
  assert.equal(normalizeImpulseSymbol('btc'), 'BTCUSDT');
  assert.equal(normalizeImpulseSymbol('BTC/USDT'), 'BTCUSDT');
  assert.equal(normalizeImpulseSymbol('solusdt'), 'SOLUSDT');
  assert.equal(normalizeImpulseSymbol(''), '');
  assert.equal(normalizeImpulseSymbol('<script>'), '');
  assert.equal(normalizeSiteNotificationSettings({ impulseThresholdPct: -1 }).impulseThresholdPct, 0.1);
  assert.equal(normalizeSiteNotificationSettings({ impulseThresholdPct: 900 }).impulseThresholdPct, 50);
  assert.equal(normalizeSiteNotificationSettings({ sound: 'pulse', impulseWindowMinutes: 15 }).sound, 'pulse');
  assert.equal(normalizeSiteNotificationSettings({ sound: 'pulse', impulseWindowMinutes: 15 }).impulseWindowMinutes, 15);
  assert.notEqual(siteNotificationStorageKey('u1'), siteNotificationStorageKey('u2'));
  assert.notEqual(siteNotificationSettingsKey('u1'), siteNotificationSettingsKey('u2'));
});

test('rolling impulse detector uses observed short-window prices, both directions and cooldown', () => {
  const tracker = new ImpulseTracker(1);
  assert.equal(tracker.push(100, 100_000, 2), null);
  assert.equal(tracker.push(100.3, 106_000, 2), null);
  const impulse = tracker.push(103, 111_000, 2);
  assert.ok(impulse);
  assert.equal(impulse?.changePct, 3);
  assert.equal(impulse?.baselinePrice, 100);
  assert.equal(tracker.push(96, 122_000, 2), null, 'no flood before cooldown');
  assert.equal(tracker.push(100, 172_000, 2), null, 'old anchor expired');
  const decline = tracker.push(97, 183_000, 2);
  assert.ok(decline);
  assert.ok((decline?.changePct || 0) < 0, 'downward impulse is recorded with a negative value');
  assert.equal(tracker.push(Number.NaN, 194_000, 2), null);
});

test('notification history never reads another account and rejects invalid local entries', () => {
  const raw = JSON.stringify([
    { id: 'e1', kind: 'impulse', title: 'BTC', description: 'Move', timestamp: 1_700_000_000_000, read: false },
    { id: 'e2', kind: 'unsupported', title: 'Other', description: 'Bad', timestamp: 1, read: false },
  ]);
  const values = readNotificationItems(raw);
  assert.equal(values.length, 1);
  assert.equal(values[0].id, 'e1');
  assert.equal(values[0].read, false);
  assert.deepEqual(readNotificationItems('not-json'), []);
});

test('header opens site event center and profile exposes notification settings', () => {
  const header = readFileSync(new URL('../src/components/Header.tsx', import.meta.url), 'utf8');
  const profile = readFileSync(new URL('../src/components/UserProfileModal.tsx', import.meta.url), 'utf8');
  const alerts = readFileSync(new URL('../src/context/AlertsContext.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(header, /<SiteNotificationBell onOpenSettings=/);
  assert.doesNotMatch(header, /id="toggle-sound-btn"/);
  assert.match(profile, /activeProfileSection === 'notifications'/);
  assert.match(profile, /<ProfileNotificationSettings/);
  assert.doesNotMatch(alerts, /playAlertChime\(\)/);
  assert.match(app, /reportStrongFormations\(data\.data/);
});
