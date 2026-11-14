import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { installPostgresIdentityRoutes } from '../server/pgIdentityRoutes';
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
      const verifySibling = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      await db.query(
        "INSERT INTO auth_action_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, 'verify-email', now() + interval '10 minutes')",
        [createHash('sha256').update(verifySibling).digest('hex'), uidA],
      );
      assert.equal(await verifyEmailToken(verifyToken), uidA);
      await assert.rejects(verifyEmailToken(verifyToken), /застаріле/);
      await assert.rejects(verifyEmailToken(verifySibling), /застаріле/,
        'another email-confirmation link must not remain usable as a login link');
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

      // Two devices must not overwrite each other's Terminal blocks.
      const workspace = (symbol: string, expected: string | null) => ({
        terminalSettings: {
          columns: 2, blockHeight: 'medium',
          blocks: [{ id: symbol, symbol, exchange: 'binance', marketType: 'futures', timeframe: '15m' }],
          _expectedVersion: expected,
        },
      });
      const firstWorkspace = await updateAccountProfile(uidA, workspace('BTCUSDT', null));
      const versionA = firstWorkspace.profile.terminalSettings?.version;
      assert.match(versionA, /^[a-f0-9-]{36}$/i);
      const nextWorkspace = await updateAccountProfile(uidA, workspace('ETHUSDT', versionA));
      const versionB = nextWorkspace.profile.terminalSettings?.version;
      assert.notEqual(versionB, versionA);
      await assert.rejects(
        updateAccountProfile(uidA, workspace('SOLUSDT', versionA)),
        (error: any) => error.status === 409 && error.code === 'TERMINAL_WORKSPACE_CONFLICT',
        'stale tab must not silently overwrite the newest Terminal workspace',
      );
      const restored = await readAccount(uidA);
      assert.equal(restored?.profile?.terminalSettings?.blocks?.[0]?.symbol, 'ETHUSDT');
      assert.equal(restored?.profile?.terminalSettings?.version, versionB);
      assert.equal('_expectedVersion' in (restored?.profile?.terminalSettings || {}), false);
      await updateAccountProfile(uidA, { soundAlertsEnabled: true });
      const unrelated = await readAccount(uidA);
      assert.equal(unrelated?.profile?.terminalSettings?.version, versionB,
        'unrelated profile writes must not invalidate Terminal concurrency');


      // Full HTTP route: regression for requirePostgresSession injecting userId
      // into the PATCH body, which previously made every profile save fail.
      const webApp = express();
      webApp.use(express.json());
      installPostgresIdentityRoutes(webApp);
      const listener = await new Promise<ReturnType<typeof webApp.listen>>((resolve, reject) => {
        const server = webApp.listen(0, '127.0.0.1', () => resolve(server));
        server.once('error', reject);
      });
      try {
        const origin = 'http://127.0.0.1:' + (listener.address() as AddressInfo).port;
        const headers = {
          Origin: origin,
          Cookie: COOKIE_NAME + '=' + session.token,
          'Content-Type': 'application/json',
          'X-CSRF-Token': current!.csrf,
        };
        const saved = await fetch(origin + '/api/account/profile', {
          method: 'PATCH', headers,
          body: JSON.stringify({ displayName: 'Profile Saved', defaultTimeframe: '15m' }),
        });
        assert.equal(saved.status, 200, await saved.text());
        const result = await readAccount(uidA);
        assert.equal(result?.user.displayName, 'Profile Saved');
        assert.equal(result?.profile.defaultTimeframe, '15m');

        const csrfRejected = await fetch(origin + '/api/account/profile', {
          method: 'PATCH', headers: { ...headers, 'X-CSRF-Token': 'invalid' },
          body: JSON.stringify({ defaultExchange: 'bybit' }),
        });
        assert.equal(csrfRejected.status, 403);

        const ownerRejected = await fetch(origin + '/api/account/profile', {
          method: 'PATCH', headers,
          body: JSON.stringify({ userId: uidB, defaultExchange: 'bybit' }),
        });
        assert.equal(ownerRejected.status, 403);

        const archiveOwned = await fetch(origin + '/api/account/archive/arch_route', {
          method: 'PUT', headers,
          body: JSON.stringify({ id: 'arch_route', userId: uidA, savedAtTimestamp: 1720000001 }),
        });
        assert.equal(archiveOwned.status, 200, await archiveOwned.text());
        assert.equal((await loadArchive(uidB)).length, 0);
        await deleteArchive(uidA, 'arch_route');
      } finally {
        await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      }
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
      const resetSibling = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      await db.query(
        "INSERT INTO auth_action_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, 'reset-password', now() + interval '10 minutes')",
        [createHash('sha256').update(resetSibling).digest('hex'), uidA],
      );
      // A structurally correct but invalid link must be rejected before hashing.
      const invalidToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      await assert.rejects(changePasswordWithToken(invalidToken, 'another-secure-password'), /застаріле/);
      await changePasswordWithToken(resetToken, 'a-new-secure-password-1234');
      await assert.rejects(checkCredentials(emailA, password), /Неправильна/);
      assert.equal((await checkCredentials(emailA, 'a-new-secure-password-1234')).user.uid, uidA);
      await assert.rejects(changePasswordWithToken(resetToken, 'another-secure-password'), /застаріле/);
      await assert.rejects(changePasswordWithToken(resetSibling, 'another-secure-password'), /застаріле/,
        'a sibling reset link must be consumed after the first successful password change');
      await assert.rejects(checkCredentials(emailA, 'x'.repeat(200000)), /Неправильна/,
        'oversized login passwords must be rejected without expensive hashing');

      // Two different links for the same account may arrive concurrently.
      // The account-level transaction lock must avoid a PostgreSQL deadlock.
      const simultaneous = [
        randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
        randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
      ];
      for (const token of simultaneous) {
        await db.query(
          "INSERT INTO auth_action_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, 'reset-password', now() + interval '10 minutes')",
          [createHash('sha256').update(token).digest('hex'), uidB],
        );
      }
      const outcomes = await Promise.allSettled(simultaneous.map((token, i) =>
        changePasswordWithToken(token, 'simultaneous-secure-password-' + i)));
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1,
        'exactly one concurrent password reset may succeed');
      const failed = outcomes.find(result => result.status === 'rejected');
      assert.ok(failed?.status === 'rejected');
      assert.match(String(failed.reason), /застаріле/,
        'losing concurrent request must be a stale token, not a SQL deadlock');

    } finally {
      await db.query('DELETE FROM auth_users WHERE id = ANY($1::text[])', [[uidA, uidB]]);
      await db.end();
    }
  });
