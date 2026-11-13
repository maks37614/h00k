/**
 * User-selected notification audio. Audio bytes stay in IndexedDB on this
 * browser/device; never upload them to our server or put them in Firestore.
 */
export const MAX_CUSTOM_SOUND_BYTES = 2 * 1024 * 1024;
export const MAX_CUSTOM_SOUND_SECONDS = 20;
const DB_NAME = 'h00k_custom_notification_audio_v1';
const STORE = 'sounds';
const EXTENSION = /\.(mp3|wav|ogg|m4a)$/i;
const MIME_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
  'application/octet-stream', '',
]);

export interface CustomNotificationSound {
  name: string;
  blob: Blob;
  savedAt: number;
}

/** Pure validation, used before allocating a blob URL or writing to disk. */
export function validateCustomNotificationSound(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  if (!EXTENSION.test(file.name) || !MIME_TYPES.has(file.type.toLowerCase()))
    return 'Підтримуються лише файли MP3, WAV, OGG або M4A.';
  if (file.size <= 0 || file.size > MAX_CUSTOM_SOUND_BYTES)
    return 'Розмір файлу має бути від 1 байта до 2 МБ.';
  return null;
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined')
    return Promise.reject(new Error('Збереження мелодії недоступне в цьому браузері.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Не вдалося відкрити локальне сховище мелодій.'));
    request.onblocked = () => reject(new Error('Закрийте інші вкладки h00k.top і повторіть.'));
  });
}

async function read(uid: string): Promise<CustomNotificationSound | null> {
  if (!uid || uid === 'guest') return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(uid);
    let value: CustomNotificationSound | null = null;
    request.onsuccess = () => {
      const data = request.result as CustomNotificationSound | undefined;
      if (data && typeof data.name === 'string' && data.blob instanceof Blob) value = data;
    };
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onerror = () => { db.close(); reject(new Error('Не вдалося прочитати мелодію.')); };
    tx.onabort = () => { db.close(); reject(new Error('Читання мелодії перервано.')); };
  });
}
async function write(uid: string, value?: CustomNotificationSound): Promise<void> {
  if (!uid || uid === 'guest') throw new Error('Спочатку увійдіть у профіль.');
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    if (value) tx.objectStore(STORE).put(value, uid);
    else tx.objectStore(STORE).delete(uid);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(new Error('Не вдалося зберегти мелодію на пристрої.')); };
    tx.onabort = () => { db.close(); reject(new Error('Збереження мелодії перервано.')); };
  });
}

function checkAudioDuration(file: File): Promise<void> {
  if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function')
    return Promise.reject(new Error('Цей браузер не підтримує перевірку аудіофайлів.'));
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    let settled = false;
    const cleanup = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => cleanup(new Error('Не вдалося прочитати аудіофайл.')), 12_000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0)
        cleanup(new Error('Браузер не зміг визначити тривалість аудіофайлу.'));
      else if (audio.duration > MAX_CUSTOM_SOUND_SECONDS)
        cleanup(new Error('Оберіть мелодію тривалістю не більше 20 секунд.'));
      else cleanup();
    };
    audio.onerror = () => cleanup(new Error('Файл пошкоджений або цей аудіоформат не підтримується браузером.'));
    audio.src = url;
    audio.load();
  });
}

export async function getCustomNotificationSound(uid: string): Promise<CustomNotificationSound | null> {
  return read(uid);
}
export async function saveCustomNotificationSound(uid: string, file: File): Promise<CustomNotificationSound> {
  const issue = validateCustomNotificationSound(file);
  if (issue) throw new Error(issue);
  await checkAudioDuration(file);
  const value = { name: file.name.slice(0, 100), blob: file, savedAt: Date.now() };
  await write(uid, value);
  return value;
}
export async function removeCustomNotificationSound(uid: string): Promise<void> {
  await write(uid);
}
