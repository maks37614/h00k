/** MP3 notification presets available on every device without user file uploads. */
export const BUNDLED_NOTIFICATION_SOUNDS = [
  { id: 'robot-talk', label: 'Голос робота', src: '/sounds/notifications/robot-talk.mp3' },
  { id: 'digital-01', label: 'Цифровий сигнал 1', src: '/sounds/notifications/digital-01.mp3' },
  { id: 'digital-02', label: 'Цифровий сигнал 2', src: '/sounds/notifications/digital-02.mp3' },
  { id: 'magic', label: 'Магічне сповіщення', src: '/sounds/notifications/magic.mp3' },
  { id: 'digital-03', label: 'Цифровий сигнал 3', src: '/sounds/notifications/digital-03.mp3' },
  { id: 'digital-04', label: 'Цифровий сигнал 4', src: '/sounds/notifications/digital-04.mp3' },
  { id: 'bird-whistle', label: 'Пташиний свист', src: '/sounds/notifications/bird-whistle.mp3' },
  { id: 'digital-05', label: 'Цифровий сигнал 5', src: '/sounds/notifications/digital-05.mp3' },
] as const;

export type BundledNotificationSoundId = typeof BUNDLED_NOTIFICATION_SOUNDS[number]['id'];
export function getBundledNotificationSound(id: string) {
  return BUNDLED_NOTIFICATION_SOUNDS.find(sound => sound.id === id);
}
