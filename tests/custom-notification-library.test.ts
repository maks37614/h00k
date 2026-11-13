import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_CUSTOM_SOUND_TRACKS, customSoundDisplayName, normalizeCustomSoundLibrary,
  validateCustomNotificationSound,
} from '../src/utils/customNotificationSound';

const userFiles = [
  ['jg-032316-sfx-robot-talk-1(1).mp3', 'Голос робота'],
  ['23ab89dc95700ba(1).mp3', 'Цифровий сигнал 1'],
  ['1c0ccd2e60335f6(1).mp3', 'Цифровий сигнал 2'],
  ['magical_sound_freetone.org(1).mp3', 'Магічне сповіщення'],
  ['59f4c8e1df6982a(2).mp3', 'Цифровий сигнал 3'],
  ['e28ae0d18cb8813(2).mp3', 'Цифровий сигнал 4'],
  ['whistle_of_a_bird_freetone.org(1).mp3', 'Пташиний свист'],
  ['4f16c5e4d065268(1).mp3', 'Цифровий сигнал 5'],
] as const;

test('all eight uploaded MP3s have readable Ukrainian names without publishing audio to the server', () => {
  for (const [file, name] of userFiles) {
    assert.equal(customSoundDisplayName(file), name);
    assert.equal(validateCustomNotificationSound({ name: file, size: 50_000, type: 'audio/mpeg' }), null);
  }
  assert.ok(MAX_CUSTOM_SOUND_TRACKS >= 8);
  assert.equal(customSoundDisplayName('my-alarm.mp3'), 'my-alarm');
});

test('a previously saved single custom melody migrates safely into the library', () => {
  const audio = new Blob(['old audio'], { type: 'audio/mpeg' });
  const legacy = normalizeCustomSoundLibrary({ name: 'old.mp3', blob: audio, savedAt: 123 });
  assert.equal(legacy.version, 2);
  assert.equal(legacy.tracks.length, 1);
  assert.equal(legacy.selectedId, 'legacy');
  assert.strictEqual(legacy.tracks[0].blob, audio);
});

test('multi-track library preserves all tracks and selected audio across reads', () => {
  const tracks = userFiles.map(([name], i) => ({
    id: String(i), name, blob: new Blob(['audio'], { type: 'audio/mpeg' }), savedAt: 123 + i,
  }));
  const library = normalizeCustomSoundLibrary({ version: 2, tracks, selectedId: '6' });
  assert.equal(library.tracks.length, 8);
  assert.equal(library.selectedId, '6');
  const fallback = normalizeCustomSoundLibrary({ tracks, selectedId: 'invalid' });
  assert.equal(fallback.selectedId, '0');
  assert.deepEqual(normalizeCustomSoundLibrary({ tracks: [], selectedId: 'bad' }).tracks, []);
});

test('all eight bundled tracks appear with the three original sound choices, without an upload form', () => {
  const profile = readFileSync(new URL('../src/components/profile/ProfileNotificationSettings.tsx', import.meta.url), 'utf8');
  assert.match(profile, /BUNDLED_NOTIFICATION_SOUNDS\.map\(sound =>/);
  for (const label of ['Дзвін','М’який','Подвійний імпульс']) assert.ok(profile.includes(label));
  assert.match(profile, /playSiteNotificationSound\(settings\.sound, soundUid\)/);
  assert.doesNotMatch(profile, /type="file"|saveCustomNotificationSounds\(|uploadPersonalSound|Додати свої мелодії/);
  assert.doesNotMatch(profile, /update\(\{\s*enabled:\s*true/);
});
