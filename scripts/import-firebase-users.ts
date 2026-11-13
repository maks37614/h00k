/**
 * One-time migration from a normalized Firebase export:
 * {"users":[{"uid":"...","email":"...","emailVerified":true,"displayName":"...",
 *            "profile":{},"archive":[...]}]}
 * Run dry first: node --import tsx scripts/import-firebase-users.ts --file /secure/export.json
 * Apply: node --import tsx scripts/import-firebase-users.ts --file /secure/export.json --apply
 * Never commit or upload personal export files to GitHub.
 */
import { readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { initializeIdentity, identityPool, hashPassword, validateEmail } from '../server/pgIdentity';

const args = process.argv.slice(2);
const fileIndex = args.indexOf('--file');
const file = fileIndex < 0 ? null : args[fileIndex + 1];
const apply = args.includes('--apply');
if (!file || file.startsWith('--')) throw new Error('Use --file /secure/firebase-normalized.json');
if (process.env.H00K_AUTH_BACKEND !== 'postgres') throw new Error('Set H00K_AUTH_BACKEND=postgres');
if (statSync(file).size > 24 * 1024 * 1024) throw new Error('Export exceeds 24MB; split into small batches before importing');
const json = JSON.parse(readFileSync(file, 'utf8')) as { users?: Array<Record<string, unknown>> };
if (!Array.isArray(json.users) || json.users.length > 1000) throw new Error('Expected { "users": [...] } with at most 1000 users per batch');

type Entry = { uid: string; email: string; name: string; emailVerified: boolean; profile: Record<string, unknown>; archive: Array<Record<string, unknown>> };
const entries: Entry[] = [];
const uids = new Set<string>(), emails = new Set<string>();
for (const raw of json.users) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid user entry');
  const uid = String(raw.uid || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || uid === 'guest') throw new Error('Invalid Firebase UID');
  const email = validateEmail(raw.email);
  if (uids.has(uid) || emails.has(email)) throw new Error('Duplicate UID or email in export');
  uids.add(uid); emails.add(email);
  const profile = raw.profile && typeof raw.profile === 'object' && !Array.isArray(raw.profile)
    ? { ...raw.profile } as Record<string, unknown> : {};
  for (const key of ['telegramBotToken', 'telegramChatId', 'telegramBotUsername', 'inviteCode', 'email', 'uid', 'createdAt', 'updatedAt']) delete profile[key];
  if (JSON.stringify(profile).length > 180000) throw new Error('Profile too large: ' + uid);
  const archive = Array.isArray(raw.archive) ? raw.archive as Array<Record<string, unknown>> : [];
  if (archive.length > 2000) throw new Error('Archive too large: ' + uid);
  for (const item of archive) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,140}$/.test(item.id) || (item.userId && item.userId !== uid)) {
      throw new Error('Invalid or cross-owned archive item: ' + uid);
    }
    if (JSON.stringify(item).length > 250000) throw new Error('Archive item too large: ' + uid);
  }
  entries.push({
    uid, email, name: String(raw.displayName || profile.displayName || email.split('@')[0]).trim().slice(0, 80) || 'Користувач',
    emailVerified: raw.emailVerified === true, profile, archive,
  });
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', users: entries.length, archives: entries.reduce((sum, user) => sum + user.archive.length, 0) }));
if (!apply) process.exit(0);
await initializeIdentity();
const client = await identityPool().connect();
try {
  await client.query('BEGIN');
  for (const entry of entries) {
    // A random unknown scrypt hash forces a verified recovery instead of copying Firebase password credentials.
    const disabledPassword = await hashPassword(randomBytes(32).toString('base64url'));
    await client.query(
      'INSERT INTO auth_users (id, email, password_hash, display_name, email_verified_at, profile) ' +
      'VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END, $6::jsonb) ON CONFLICT (id) DO NOTHING',
      [entry.uid, entry.email, disabledPassword, entry.name, entry.emailVerified, JSON.stringify(entry.profile)],
    );
    const { rows } = await client.query('SELECT email FROM auth_users WHERE id = $1', [entry.uid]);
    if (rows[0]?.email !== entry.email) throw new Error('UID/email mismatch: ' + entry.uid);
    for (const item of entry.archive) {
      const body = { ...item, userId: entry.uid };
      await client.query(
        'INSERT INTO auth_archives (user_id, id, payload, saved_at) VALUES ($1, $2, $3::jsonb, $4) ' +
        'ON CONFLICT (user_id, id) DO NOTHING',
        [entry.uid, item.id, JSON.stringify(body),
          Number.isFinite(Number(item.savedAtTimestamp)) ? Number(item.savedAtTimestamp) : Date.now()],
      );
    }
  }
  await client.query('COMMIT');
  console.log('Accounts and formations imported; email/password recovery required before sign-in.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await identityPool().end();
}
