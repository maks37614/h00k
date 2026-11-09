import { verify, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import type { Request, Response, NextFunction } from 'express';

const firebaseProject = JSON.parse(fs.readFileSync(new URL('../firebase-applet-config.json', import.meta.url), 'utf8')).projectId as string;
const certificatesUrl = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certificates: Record<string, string> = {};
let expiresAt = 0;
let fetchedAt = 0;
let loading: Promise<void> | undefined;

class AuthenticationError extends Error {
  status: number;
  constructor(message: string, status = 401) { super(message); this.status = status; }
}

async function refreshCertificates() {
  if (!loading) loading = (async () => {
    try {
      const response = await fetch(certificatesUrl, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Certificate service unavailable');
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.values(data).every(value => typeof value === 'string')) throw new Error('Invalid certificates');
      certificates = data;
      const maxAge = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 300);
      fetchedAt = Date.now();
      expiresAt = fetchedAt + Math.min(86400, Math.max(1, maxAge)) * 1000;
    } catch {
      throw new AuthenticationError('Сервіс перевірки входу тимчасово недоступний. Спробуйте ще раз.', 503);
    }
  })().finally(() => { loading = undefined; });
  await loading;
}

export async function verifyFirebaseToken(token: string): Promise<string> {
  const invalid = () => new AuthenticationError('Сесія входу недійсна або закінчилась. Увійдіть повторно.');
  if (token.length > 12000) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
  let header: any, claims: any;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { throw invalid(); }
  const now = Date.now() / 1000;
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256 ||
    claims?.aud !== firebaseProject || claims.iss !== `https://securetoken.google.com/${firebaseProject}` ||
    typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub === 'guest' || claims.sub.length > 128 ||
    typeof claims.exp !== 'number' || claims.exp <= now ||
    typeof claims.iat !== 'number' || claims.iat > now + 30 ||
    typeof claims.auth_time !== 'number' || claims.auth_time > now + 30) throw invalid();
  if (Date.now() >= expiresAt || !certificates[header.kid] && Date.now() - fetchedAt > 60000) await refreshCertificates();
  const certificate = Object.hasOwn(certificates, header.kid) ? certificates[header.kid] : undefined;
  if (!certificate) throw invalid();
  try {
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(certificate), Buffer.from(parts[2], 'base64url'))) throw invalid();
  } catch { throw invalid(); }
  return claims.sub;
}

/** An authenticated UID is authoritative; request parameters cannot select another owner. */
export async function requireUserAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authorization = req.get('Authorization') || '';
    const match = authorization.match(/^Bearer ([A-Za-z0-9_.-]+)$/i);
    if (!match) throw new AuthenticationError('Увійдіть у свій акаунт для керування сповіщеннями.');
    const userId = await verifyFirebaseToken(match[1]);
    const provided = [req.query.userId, req.body?.userId].filter(value => value !== undefined);
    if (provided.some(value => value !== userId)) throw new AuthenticationError('Немає доступу до даних іншого користувача.', 403);
    req.query.userId = userId;
    req.body = { ...(req.body || {}), userId };
    res.locals.userId = userId;
    next();
  } catch (error) {
    const status = error instanceof AuthenticationError ? error.status : 401;
    res.status(status).json({ success: false, error: error instanceof Error ? error.message : 'Помилка авторизації' });
  }
}
