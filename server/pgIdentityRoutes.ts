import type { Express, Request, Response, NextFunction } from 'express';
import {
  AuthFailure, COOKIE_NAME, usePostgresAuth, registerAccount, checkCredentials,
  verifyEmailToken, resendVerification, sendReset, changePasswordWithToken, readAccount,
  createSession, currentSession, revokeSession, revokeAllSessions, listSessions,
  updateAccountProfile, loadArchive, saveArchive, deleteArchive, clearArchive, touchSession,
} from './pgIdentity';

const cookieOptions = (days: number, remember = true) => ({
  httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const,
  path: '/', ...(remember ? { maxAge: days * 24 * 60 * 60 * 1000 } : {}),
});
const clearSessionCookie = (res: Response) => res.clearCookie(COOKIE_NAME, {
  path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
});
function failed(res: Response, error: unknown) {
  const known = error instanceof AuthFailure;
  if (!known) console.error('[Postgres identity]', error instanceof Error ? error.message : 'Unexpected error');
  res.status(known ? error.status : 503).json({
    success: false, code: known ? error.code : 'AUTH_TEMPORARILY_UNAVAILABLE',
    error: known ? error.message : 'Сервіс авторизації тимчасово недоступний.',
  });
}
function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => { Promise.resolve(handler(req, res)).catch(error => failed(res, error)); };
}

// Small bounded in-process abuse budget. One app replica; for horizontal scaling
// move this to Redis/PG with the same quotas. Never rate-limit market feed endpoints.
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(req: Request, kind: string, max: number, durationMs: number) {
  const now = Date.now();
  if (buckets.size > 12000) {
    for (const [k, v] of buckets) { if (v.resetAt <= now) buckets.delete(k); }
    if (buckets.size > 12000) buckets.clear();
  }
  const identity = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
  const keys = [kind + ':ip:' + req.ip, kind + ':email:' + identity];
  if (!identity) keys.pop();
  for (const key of keys) {
    const record = buckets.get(key);
    if (record && record.resetAt > now && record.count >= max) throw new AuthFailure(429, 'Забагато спроб. Спробуйте пізніше.', 'RATE_LIMITED');
  }
  for (const key of keys) {
    const record = buckets.get(key);
    buckets.set(key, record && record.resetAt > now
      ? { count: record.count + 1, resetAt: record.resetAt }
      : { count: 1, resetAt: now + durationMs });
  }
}

function checkOrigin(req: Request) {
  const origin = req.get('Origin');
  const host = req.get('Host') || '';
  if (!origin) {
    // Non-browser clients cannot use cross-site cookies as credentials.
    // Allow origin-less API calls; authenticated mutations still require CSRF.
    return;
  }
  let url: URL;
  try { url = new URL(origin); } catch { throw new AuthFailure(403, 'Неприпустиме походження запиту.'); }
  if (url.host !== host || !['https:', 'http:'].includes(url.protocol)) {
    throw new AuthFailure(403, 'Неприпустиме походження запиту.', 'BAD_ORIGIN');
  }
}
function protectOrigin(req: Request, res: Response, next: NextFunction) {
  try { checkOrigin(req); next(); } catch (error) { failed(res, error); }
}

export async function requirePostgresSession(req: Request, res: Response, next: NextFunction) {
  try {
    const session = await currentSession(req);
    if (!session) throw new AuthFailure(401, 'Увійдіть у свій акаунт.', 'SESSION_EXPIRED');
    // Cookie-backed writes must prove same-origin JS access.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      checkOrigin(req);
      if (req.get('X-CSRF-Token') !== session.csrf) throw new AuthFailure(403, 'Недійсний токен захисту запиту.', 'BAD_CSRF');
    }
    const provided = [req.query?.userId, req.body?.userId].filter(v => v !== undefined);
    if (provided.some(v => v !== session.userId)) throw new AuthFailure(403, 'Немає доступу до чужих даних.', 'WRONG_OWNER');
    req.query.userId = session.userId;
    req.body = { ...(req.body || {}), userId: session.userId };
    res.locals.userId = session.userId;
    res.locals.sessionId = session.id;
    next();
  } catch (error) { failed(res, error); }
}

export function installPostgresIdentityRoutes(app: Express) {
  if (!usePostgresAuth()) return;
  // Schema initialization is shared and idempotent; startServer awaits it first.
  app.disable('x-powered-by');
  app.get('/api/auth/config', (_req, res) => res.setHeader('Cache-Control', 'no-store').json({ backend: 'postgres' }));
  app.use(['/api/auth', '/api/account'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.post('/api/auth/register', protectOrigin, wrap(async (req, res) => {
    rateLimit(req, 'signup', 4, 60 * 60 * 1000);
    await registerAccount(req.body?.email, req.body?.password, req.body?.displayName);
    res.status(202).json({ success: true, message: 'Перевірте пошту та підтвердіть адресу.' });
  }));
  app.post('/api/auth/resend-verification', protectOrigin, wrap(async (req, res) => {
    rateLimit(req, 'verify', 3, 60 * 60 * 1000);
    await resendVerification(req.body?.email);
    res.json({ success: true });
  }));
  app.post('/api/auth/login', protectOrigin, wrap(async (req, res) => {
    rateLimit(req, 'login', 10, 15 * 60 * 1000);
    const account = await checkCredentials(req.body?.email, req.body?.password);
    const session = await createSession(account.user.uid, req, req.body?.remember !== false);
    res.cookie(COOKIE_NAME, session.token, cookieOptions(session.days, req.body?.remember !== false));
    const current = await currentSessionFromToken(req, session.token);
    res.json({ success: true, ...account, csrf: current.csrf });
  }));
  app.post('/api/auth/verify-email', protectOrigin, wrap(async (req, res) => {
    rateLimit(req, 'email-link', 12, 60 * 60 * 1000);
    const userId = await verifyEmailToken(req.body?.token);
    const account = await readAccount(userId);
    if (!account) throw new AuthFailure(404, 'Акаунт не знайдено.');
    const session = await createSession(userId, req);
    res.cookie(COOKIE_NAME, session.token, cookieOptions(session.days));
    res.json({ success: true, ...account, csrf: (await currentSessionFromToken(req, session.token)).csrf });
  }));
  app.post('/api/auth/forgot-password', protectOrigin, wrap(async (req, res) => {
    rateLimit(req, 'forgot', 4, 60 * 60 * 1000);
    await sendReset(req.body?.email);
    res.json({ success: true, message: 'Якщо акаунт існує, ми надішлемо лист для відновлення.' });
  }));
  app.post('/api/auth/reset-password', protectOrigin, wrap(async (req, res) => {
    rateLimit(req, 'password-reset', 8, 60 * 60 * 1000);
    await changePasswordWithToken(req.body?.token, req.body?.password);
    clearSessionCookie(res);
    res.json({ success: true, message: 'Пароль змінено. Увійдіть повторно.' });
  }));
  app.get('/api/auth/session', wrap(async (req, res) => {
    const session = await currentSession(req);
    if (!session) { res.status(401).json({ success: false, code: 'SESSION_EXPIRED' }); return; }
    const account = await readAccount(session.userId);
    if (!account) { res.status(401).json({ success: false }); return; }
    void touchSession(session.id);
    res.json({ success: true, ...account, csrf: session.csrf });
  }));
  app.post('/api/auth/logout', requirePostgresSession, wrap(async (_req, res) => {
    await revokeSession(res.locals.userId, res.locals.sessionId);
    clearSessionCookie(res);
    res.json({ success: true });
  }));
  app.post('/api/auth/logout-all', requirePostgresSession, wrap(async (_req, res) => {
    await revokeAllSessions(res.locals.userId);
    clearSessionCookie(res);
    res.json({ success: true });
  }));
  app.get('/api/auth/sessions', requirePostgresSession, wrap(async (_req, res) => {
    res.json({ success: true, sessions: await listSessions(res.locals.userId) });
  }));
  app.delete('/api/auth/sessions/:id', requirePostgresSession, wrap(async (req, res) => {
    await revokeSession(res.locals.userId, String(req.params.id));
    const revokedCurrent = req.params.id === res.locals.sessionId;
    if (revokedCurrent) clearSessionCookie(res);
    res.json({ success: true, revokedCurrent });
  }));
  app.patch('/api/account/profile', requirePostgresSession, wrap(async (req, res) => {
    // The ownership middleware injects userId for legacy endpoints; it must not
    // become an editable profile field. Only authenticated session UID is trusted.
    const { userId: _authenticatedOwner, ...updates } = req.body || {};
    const account = await updateAccountProfile(res.locals.userId, updates);
    res.json({ success: true, ...account });
  }));
  app.get('/api/account/archive', requirePostgresSession, wrap(async (_req, res) => {
    res.json({ success: true, items: await loadArchive(res.locals.userId) });
  }));
  app.put('/api/account/archive/:id', requirePostgresSession, wrap(async (req, res) => {
    const item = await saveArchive(res.locals.userId, req.params.id, req.body);
    res.json({ success: true, item });
  }));
  app.delete('/api/account/archive', requirePostgresSession, wrap(async (_req, res) => {
    await clearArchive(res.locals.userId);
    res.json({ success: true });
  }));
  app.delete('/api/account/archive/:id', requirePostgresSession, wrap(async (req, res) => {
    await deleteArchive(res.locals.userId, String(req.params.id));
    res.json({ success: true });
  }));
}

// On login the cookie isn't in req yet. Avoid a second DB lookup;
 // the CSRF token is derived only from the new unpredictable session secret.
import { csrfForSession } from './pgIdentity';
async function currentSessionFromToken(_req: Request, token: string) { return { csrf: csrfForSession(token) }; }
