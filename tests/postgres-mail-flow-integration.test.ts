import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import nodemailer from 'nodemailer';
import { installPostgresIdentityRoutes } from '../server/pgIdentityRoutes';
import { identityPool, COOKIE_NAME } from '../server/pgIdentity';

type CapturedMail = { from: string; to: string; subject: string; text: string };
function tokenFrom(message: CapturedMail, param: 'verifyEmail' | 'resetPassword'): string {
  const match = message.text.match(/https:\/\/[^\s]+/);
  assert.ok(match, 'email contains an absolute HTTPS action link');
  const url = new URL(match[0]);
  assert.equal(url.origin, 'https://h00k.top');
  const token = url.searchParams.get(param);
  assert.match(token || '', /^[A-Za-z0-9_-]{40,80}$/);
  return token!;
}

test('real PostgreSQL and captured SMTP: register, verify, login, recover, resend and revoke', {
  skip: process.env.H00K_PG_INTEGRATION_TEST !== '1',
}, async t => {
  const old = {
    host: process.env.SMTP_HOST,
    from: process.env.SMTP_FROM,
    port: process.env.SMTP_PORT,
    base: process.env.PUBLIC_BASE_URL,
  };
  const id1 = randomUUID(), id2 = randomUUID();
  const email = 'auth-mail-' + id1 + '@example.invalid';
  const email2 = 'auth-resend-' + id2 + '@example.invalid';
  let mailFails = false;
  const mail: CapturedMail[] = [];

  // Replace only the transport, not the auth or SQL logic. Never send external mail in CI.
  t.mock.method(nodemailer, 'createTransport', () => ({
    async sendMail(item: CapturedMail) {
      if (mailFails) throw new Error('Simulated SMTP transport outage');
      mail.push(item);
      return { accepted: [item.to] };
    },
  }));
  let server: Server | undefined;
  let db: ReturnType<typeof identityPool> | undefined;
  try {
    process.env.SMTP_HOST = '';
    process.env.SMTP_FROM = '';
    process.env.PUBLIC_BASE_URL = 'https://h00k.top';
    process.env.SMTP_PORT = '587';

    const app = express();
    app.use(express.json());
    installPostgresIdentityRoutes(app);
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const post = (route: string, data: unknown, credentials?: { cookie: string; csrf: string }) => fetch(origin + route, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(credentials ? { Cookie: credentials.cookie, 'X-CSRF-Token': credentials.csrf } : {}),
      },
      body: JSON.stringify(data),
    });
    db = identityPool();

    const noMail = await post('/api/auth/register', { email, password: 'strong-password-with-12-chars' });
    assert.equal(noMail.status, 503);
    assert.equal((await noMail.json()).code, 'MAIL_NOT_CONFIGURED');
    const noAccount = await db.query('SELECT id FROM auth_users WHERE email = $1', [email]);
    assert.equal(noAccount.rows.length, 0, 'do not create accounts with no configured mail sender');

    process.env.SMTP_HOST = 'smtp.example.invalid';
    process.env.SMTP_FROM = 'h00k <auth@example.invalid>';
    const register = await post('/api/auth/register', {
      email, password: 'strong-password-with-12-chars', displayName: 'New Trader',
    });
    assert.equal(register.status, 202, await register.text());
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to, email);
    assert.match(mail[0].subject, /підтвердження/);
    const verifyToken = tokenFrom(mail[0], 'verifyEmail');

    const beforeVerification = await post('/api/auth/login', {
      email, password: 'strong-password-with-12-chars',
    });
    assert.equal(beforeVerification.status, 403);
    assert.equal((await beforeVerification.json()).code, 'EMAIL_UNVERIFIED');

    const verify = await post('/api/auth/verify-email', { token: verifyToken });
    const verifyBody = await verify.json();
    assert.equal(verify.status, 200, JSON.stringify(verifyBody));
    assert.equal(verifyBody.user.emailVerified, true);
    const verifyAgain = await post('/api/auth/verify-email', { token: verifyToken });
    assert.equal(verifyAgain.status, 400, 'email action links are one-use');

    const login = await post('/api/auth/login', {
      email, password: 'strong-password-with-12-chars', remember: true,
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.match(cookie || '', new RegExp('^' + COOKIE_NAME + '='));
    const body = await login.json();
    assert.equal(body.profile.displayName, 'New Trader');
    const credentials = { cookie: cookie!, csrf: String(body.csrf) };
    const session = await fetch(origin + '/api/auth/session', { headers: { Cookie: cookie! } });
    assert.equal(session.status, 200, 'session survives a page reload');
    assert.equal((await session.json()).user.email, email);

    const unknown = await post('/api/auth/forgot-password', { email: 'nobody@example.invalid' });
    assert.equal(unknown.status, 200, 'password reset does not reveal non-existent emails');
    assert.equal(mail.length, 1, 'unknown emails produce no outgoing message');
    const forgot = await post('/api/auth/forgot-password', { email });
    assert.equal(forgot.status, 200);
    assert.equal(mail.length, 2);
    assert.match(mail[1].subject, /пароля/);
    const resetToken = tokenFrom(mail[1], 'resetPassword');

    // Simulate failure of a replacement email: the previous link must still work.
    mailFails = true;
    const failedResetMail = await post('/api/auth/forgot-password', { email });
    assert.equal(failedResetMail.status, 503);
    assert.equal((await failedResetMail.json()).code, 'MAIL_DELIVERY_FAILED');
    mailFails = false;

    const invalidReset = await post('/api/auth/reset-password', {
      token: 'not-a-token', password: 'new-password-with-12-chars',
    });
    assert.equal(invalidReset.status, 400);
    const reset = await post('/api/auth/reset-password', {
      token: resetToken, password: 'new-password-with-12-chars',
    });
    assert.equal(reset.status, 200, await reset.text());
    assert.equal((await post('/api/auth/reset-password', {
      token: resetToken, password: 'another-password-with-12-chars',
    })).status, 400);
    assert.equal((await post('/api/auth/login', {
      email, password: 'strong-password-with-12-chars',
    })).status, 401, 'original password is invalidated');
    assert.equal((await post('/api/auth/login', {
      email, password: 'new-password-with-12-chars',
    })).status, 200);
    assert.equal((await fetch(origin + '/api/auth/session', {
      headers: { Cookie: credentials.cookie },
    })).status, 401, 'a password reset revokes remembered sessions');

    // If registration email delivery failed, the user can resend without losing the account.
    mailFails = true;
    const failedRegistration = await post('/api/auth/register', {
      email: email2, password: 'fresh-registration-12-chars',
    });
    assert.equal(failedRegistration.status, 503);
    assert.equal((await failedRegistration.json()).code, 'MAIL_DELIVERY_FAILED');
    mailFails = false;
    const resend = await post('/api/auth/resend-verification', { email: email2 });
    assert.equal(resend.status, 200);
    const lastMail = mail[mail.length - 1];
    assert.equal(lastMail.to, email2);
    const verifyAfterRetry = await post('/api/auth/verify-email', {
      token: tokenFrom(lastMail, 'verifyEmail'),
    });
    assert.equal(verifyAfterRetry.status, 200, 'SMTP failure does not strand a new account');
  } finally {
    if (server) await new Promise<void>((resolve, reject) =>
      server!.close(error => error ? reject(error) : resolve()));
    if (db) {
      await db.query('DELETE FROM auth_users WHERE email = ANY($1::text[])', [[email, email2]]);
      await db.end();
    }
    for (const [name, value] of Object.entries({
      SMTP_HOST: old.host,
      SMTP_FROM: old.from,
      SMTP_PORT: old.port,
      PUBLIC_BASE_URL: old.base,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
