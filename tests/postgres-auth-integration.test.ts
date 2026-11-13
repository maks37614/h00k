import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  initializeIdentity, identityPool, hashPassword, checkCredentials, createSession,
  currentSession, readAccount, updateAccountProfile, saveArchive, loadArchive, deleteArchive,
  verifyEmailToken, changePasswordWithToken, revokeSession, COOKIE_NAME,
} from '../server/pgIdentity';

test('real PostgreSQL: verify email, login, isolate data, revoke session and reset password',
  { skip: process.env.H00K_PG_INTEGRATION_TEST !== '1' },
  async () => {
    const uidA = randomUUID();
    const uidB = randomUUID();
    const emailA = 'auth-a-' + uidA + '@example.invalid';
    const emailB = 'auth-b-' + uidB + '@example.invalid';
    const password = 'safe-test-password-1234';
    await initializeIdentity();
    const db = identityPool();
    try {
      const hash = await hashPassword(password);
      await db.query('INSERT INTO auth_users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)',
        [uidA, emailA, 'Alpha', hash]);
      await db.query('INSERT INTO auth_users (id, email, display_name, password_hash, email_verified_at) VALUES ($1, $2, $3, $4, now())',
        [uidB, emailB, 'Beta', hash]);

      await assert.rejects(checkCredentials(emailA, password), /Підтвердіть/);
      const verifyToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      const verificationHash = createHash('sha256').update(verifyToken).digest('hex');
      await db.query(
        "INSERT INTO auth_action_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, 'verify-email', now() + interval '10 minutes')",
        [verificationHash, uidA],
      );
      assert.equal(await verifyEmailToken(verifyToken), uidA);
      await assert.rejects(verifyEmailToken(verifyToken), /застаріле/);
      const credentials = await checkCredentials(emailA, password);
      assert.equal(credentials.user.uid, uidA);
      assert.equal(credentials.user.emailVerified, true);

      const request = { get(key: string) { return key === 'User-Agent' ? 'h00k-offline-test' : ''; }, ip: '127.0.0.1' } as any;
      const session = await createSession(uidA, request);
      const requestWithCookie = { get(key: string) { return key === 'Cookie' ? COOKIE_NAME + '=' + session.token : ''; } } as any;
      const current = await currentSession(requestWithCookie);
      assert.equal(current?.userId, uidA);
      assert.equal(typeof current?.csrf, 'string');
      await updateAccountProfile(uidA, { displayName: 'Alpha Scalper', defaultExchange: 'binance' });
      assert.equal((await readAccount(uidA))?.profile?.defaultExchange, 'binance');
      await saveArchive(uidA, 'arch_one', { id: 'arch_one', savedAtTimestamp: 1720000000 });
      assert.equal((await loadArchive(uidA)).length, 1);
      assert.equal((await loadArchive(uidB)).length, 0);
      await assert.rejects(saveArchive(uidA, 'arch_wrong', { userId: uidB }), /Немає доступу/);
      await deleteArchive(uidA, 'arch_one');
      assert.equal((await loadArchive(uidA)).length, 0);
      assert.equal(await revokeSession(uidA, current!.id), true);
      assert.equal(await currentSession(requestWithCookie), null);

      const resetToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      const resetHash = createHash('sha256').update(resetToken).digest('hex');
      await db.query(
        "INSERT INTO auth_action_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, 'reset-password', now() + interval '10 minutes')",
        [resetHash, uidA],
      );
      await changePasswordWithToken(resetToken, 'a-new-secure-password-1234');
      await assert.rejects(checkCredentials(emailA, password), /Неправильна/);
      assert.equal((await checkCredentials(emailA, 'a-new-secure-password-1234')).user.uid, uidA);
      await assert.rejects(changePasswordWithToken(resetToken, 'another-secure-password'), /застаріле/);
    } finally {
      await db.query('DELETE FROM auth_users WHERE id = ANY($1::text[])', [[uidA, uidB]]);
      await db.end();
    }
  });
