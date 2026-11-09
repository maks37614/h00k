import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';

/** Disposable test signing key; its public half is passed only to the offline fixture. */
export function createTestSession() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const projectId = JSON.parse(fs.readFileSync(new URL('../../firebase-applet-config.json', import.meta.url), 'utf8')).projectId;
  return {
    env: { H00K_TEST_AUTH_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    headers(userId: string) {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'offline-fixture' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ sub: userId, aud: projectId, iss: `https://securetoken.google.com/${projectId}`,
        exp: now + 3600, iat: now - 5, auth_time: now - 10 })).toString('base64url');
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
      return { Authorization: `Bearer ${header}.${body}.${signature}` };
    },
  };
}
