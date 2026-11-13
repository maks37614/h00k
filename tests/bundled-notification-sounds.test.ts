import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUNDLED_NOTIFICATION_SOUNDS, getBundledNotificationSound } from '../src/utils/notificationSoundPresets';
import { normalizeSiteNotificationSettings } from '../src/utils/siteNotifications';

const soundService = readFileSync(new URL('../src/utils/domSound.ts', import.meta.url), 'utf8');
const profile = readFileSync(new URL('../src/components/profile/ProfileNotificationSettings.tsx', import.meta.url), 'utf8');

test('8 built-in MP3 tracks are available as static assets on every device', () => {
  assert.equal(BUNDLED_NOTIFICATION_SOUNDS.length, 8);
  assert.equal(new Set(BUNDLED_NOTIFICATION_SOUNDS.map(sound => sound.id)).size, 8);
  for (const sound of BUNDLED_NOTIFICATION_SOUNDS) {
    assert.match(sound.src, /^\/sounds\/notifications\/[a-z0-9-]+\.mp3$/);
    assert.ok(sound.label.length > 3);
    const bytes = readFileSync(new URL('../public' + sound.src, import.meta.url));
    assert.ok(bytes.byteLength >= 1000);
    assert.ok(bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 0xff, sound.id);
    assert.equal(getBundledNotificationSound(sound.id)?.src, sound.src);
  }
});

test('selected MP3 preset survives reload normalization without opting into notifications', () => {
  for (const sound of BUNDLED_NOTIFICATION_SOUNDS) {
    const s = normalizeSiteNotificationSettings({
      sound: sound.id, enabled: false, optedIn: false, browserPush: true, telegramEnabled: true,
    });
    assert.equal(s.sound, sound.id);
    assert.equal(s.enabled, false);
    assert.equal(s.browserPush, false);
    assert.equal(s.telegramEnabled, false);
  }
  assert.equal(normalizeSiteNotificationSettings({ sound: 'unknown' }).sound, 'chime');
});

test('profile has built-in sounds instead of upload controls; preview and mute work', () => {
  assert.match(profile, /BUNDLED_NOTIFICATION_SOUNDS\.map\(sound =>/);
  assert.doesNotMatch(profile, /type="file"|uploadPersonalSound|saveCustomNotificationSounds/);
  assert.match(profile, /playSiteNotificationSound\(settings\.sound, soundUid\)/);
  assert.match(soundService, /getBundledNotificationSound\(preset\)/);
  assert.match(soundService, /new Audio\(bundled\.src\)/);
  assert.match(soundService, /activeBundledSound\.pause\(\)/);
  assert.match(soundService, /void audio\.play\(\)\.catch\(cleanup\)/);
  assert.match(soundService, /if \(allowed && !allowed\(\)\) return/);
});
