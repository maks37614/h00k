import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyFirebaseToken, requireUserAuth } from '../server/userAuth';

const projectId = JSON.parse(fs.readFileSync(new URL('../firebase-applet-config.json', import.meta.url), 'utf8')).projectId;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
let certificateRequests = 0;

function token(uid = 'alice', changes: Record<string, unknown> = {}, headerChanges: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key', ...headerChanges })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ aud: projectId, iss: `https://securetoken.google.com/${projectId}`, sub: uid,
    exp: now + 3600, iat: now - 10, auth_time: now - 60, ...changes })).toString('base64url');
  return `${header}.${claims}.${sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey).toString('base64url')}`;
}

test('real RSA signatures identify each owner and certificates are cached', async () => {
  globalThis.fetch = async input => {
    assert.match(String(input), /securetoken@system\.gserviceaccount\.com$/);
    certificateRequests++;
    return Response.json({ 'fixture-key': pem }, { headers: { 'cache-control': 'public, max-age=3600' } });
  };
  assert.equal(await verifyFirebaseToken(token('alice')), 'alice');
  assert.equal(await verifyFirebaseToken(token('bob')), 'bob');
  assert.equal(certificateRequests, 1);
});

test('expired, forged, wrong-project, guest and algorithm-confusion tokens are rejected', async () => {
  for (const invalid of [token('alice', { exp: 1 }), token('alice', { aud: 'another-project' }),
    token('alice', { iss: 'https://example.com' }), token('guest'), token('alice', { iat: 99999999999 }),
    token('alice', { auth_time: 99999999999 }), token('alice', {}, { alg: 'none' }), 'not-a-token']) {
    await assert.rejects(verifyFirebaseToken(invalid), /недійсна|закінчилась/);
  }
  const original = token();
  const forged = original.slice(0, original.lastIndexOf('.') + 1) + Buffer.alloc(256, 1).toString('base64url');
  await assert.rejects(verifyFirebaseToken(forged), /недійсна/);
});

async function authenticate(authorization?: string, query: any = {}, body: any = {}) {
  let status = 200, result: any, accepted = false;
  const req: any = { get: () => authorization, query: { ...query }, body: { ...body } };
  const res: any = { locals: {}, status(code: number) { status = code; return this; }, json(value: unknown) { result = value; } };
  await requireUserAuth(req, res, () => { accepted = true; });
  return { status, result, accepted, req, res };
}

test('the API derives ownership from the verified session and rejects another requested user', async () => {
  const authorization = `Bearer ${token('alice')}`;
  const own = await authenticate(authorization);
  assert.equal(own.accepted, true);
  assert.equal(own.req.query.userId, 'alice');
  assert.equal(own.req.body.userId, 'alice');
  assert.equal(own.res.locals.userId, 'alice');
  assert.equal((await authenticate(authorization, { userId: 'bob' })).status, 403);
  assert.equal((await authenticate(authorization, {}, { userId: 'bob' })).status, 403);
  assert.equal((await authenticate(undefined, { userId: 'alice' })).status, 401);
  assert.equal((await authenticate('Bearer fake', {}, { userId: 'alice' })).status, 401);
});

test('certificate outages fail closed instead of accepting the claimed userId', async () => {
  const now = Date.now;
  const validToken = token('alice', { exp: Math.floor(now() / 1000) + 10000 });
  Date.now = () => now() + 3700 * 1000;
  globalThis.fetch = async () => { throw new Error('Fixture certificate outage'); };
  try { await assert.rejects(verifyFirebaseToken(validToken), (error: any) => error.status === 503); }
  finally { Date.now = now; }
});
