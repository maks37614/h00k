import { auth } from '../firebase';

/** Send a real Firebase session and reject requests left over from another account. */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (!url.startsWith('/api/')) throw new Error('Неприпустима адреса запиту');
  await auth.authStateReady();
  const account = auth.currentUser;
  if (!account) throw new Error('Увійдіть у свій акаунт через Google або email.');
  const queryOwner = new URL(url, 'https://h00k.top').searchParams.get('userId');
  let bodyOwner: string | undefined;
  if (typeof options.body === 'string') {
    try { bodyOwner = JSON.parse(options.body)?.userId; } catch {}
  }
  if ([queryOwner, bodyOwner].some(owner => owner && owner !== account.uid)) throw new Error('Акаунт змінився. Повторіть дію.');
  const token = await account.getIdToken();
  if (auth.currentUser?.uid !== account.uid) throw new Error('Акаунт змінився. Повторіть дію.');
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  if (auth.currentUser?.uid !== account.uid) throw new Error('Акаунт змінився. Повторіть дію.');
  return response;
}
