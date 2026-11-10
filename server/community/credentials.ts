import { randomBytes, randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import * as OTPAuth from "otpauth";
import type { Database } from "./db";
import type { Account } from "./session";
import { fail, tokenHash, unseal } from "./security";

export const passwordHashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;
export interface CredentialAccount {
  id: string;
  email: string;
  email_verified: boolean;
  profile: any;
  password_hash: string;
  mfa_secret: string | null;
  mfa_pending: string | null;
  mfa_last_counter: string | number;
  deleted_at: Date | null;
}
export interface FactorInput {
  code?: unknown;
  recoveryCode?: unknown;
  password?: unknown;
}
const fallback =
  "$argon2id$v=19$m=19456,t=2,p=1$SW52YWxpZFVzZXJTYWx0MQ$6Fwt8UL0Nfc4x0SZYQKpm5m8/xcHnQ3P+PvByXYhaUk";
export async function matchesPassword(
  hash: string | undefined,
  input: unknown,
) {
  const supplied =
    typeof input === "string" && input.length <= 256 ? input : "";
  return argon2.verify(hash ?? fallback, supplied).catch(() => false);
}
export function totpCounter(
  secret: string,
  code: unknown,
  now = Date.now(),
): number | null {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const delta = new OTPAuth.TOTP({
    issuer: "h00k",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  }).validate({ token: code, window: 1, timestamp: now });
  return delta === null ? null : Math.floor(now / 30_000) + delta;
}
function recoveryHash(userId: string, raw: unknown) {
  const value =
    typeof raw === "string" ? raw.replace(/[\s-]/g, "").toLowerCase() : "";
  if (!/^[a-f0-9]{32}$/.test(value))
    fail("Некоректний або використаний резервний код", 401);
  return tokenHash(userId + ":" + value);
}
/** Call inside the same transaction as the protected action, after locking the account. */
export async function consumeFactor(
  tx: Database,
  user: CredentialAccount,
  input: FactorInput,
  now = Date.now(),
) {
  if (!user.mfa_secret) fail("Другий фактор не налаштовано", 403);
  if (input.recoveryCode) {
    const { rows } = await tx.query(
      "UPDATE hc_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING code_hash",
      [user.id, recoveryHash(user.id, input.recoveryCode)],
    );
    if (!rows.length) fail("Некоректний або використаний резервний код", 401);
    await securityNotice(
      tx,
      user.id,
      "recovery-code-used",
      "Використано резервний код другого фактора. Перевірте сеанси та налаштування 2FA.",
    );
    return;
  }
  const counter = totpCounter(
    unseal(user.mfa_secret, user.id),
    input.code,
    now,
  );
  if (counter === null || counter <= Number(user.mfa_last_counter))
    fail(
      "Некоректний або вже використаний код 2FA. Дочекайтеся нового коду.",
      401,
    );
  const result = await tx.query(
    "UPDATE hc_users SET mfa_last_counter=$2 WHERE id=$1 AND mfa_secret=$3 AND mfa_last_counter<$2 RETURNING id",
    [user.id, counter, user.mfa_secret],
  );
  if (!result.rows.length) fail("Код 2FA вже використано", 401);
}
/** An active cookie alone never authorizes replacement, export or deletion. */
export async function withCredentials<T>(
  db: Database,
  account: Account,
  input: FactorInput,
  run: (tx: Database, user: CredentialAccount) => Promise<T>,
  now = Date.now(),
) {
  const initial = await db.query<CredentialAccount>(
    "SELECT * FROM hc_users WHERE id=$1 AND deleted_at IS NULL",
    [account.id],
  );
  if (
    !initial.rows[0] ||
    !(await matchesPassword(initial.rows[0]?.password_hash, input.password))
  )
    fail("Підтвердіть поточний пароль", 401);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<CredentialAccount>(
      `SELECT u.* FROM hc_users u JOIN hc_sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at>now() AND u.deleted_at IS NULL FOR UPDATE OF u FOR SHARE OF s`,
      [account.id, account.tokenHash],
    );
    const user = rows[0];
    if (!user || user.password_hash !== initial.rows[0].password_hash)
      fail("Сеанс або пароль змінився. Увійдіть знову.", 401);
    if (user.mfa_secret) await consumeFactor(tx, user, input, now);
    return run(tx, user);
  });
}
export async function replaceRecoveryCodes(tx: Database, userId: string) {
  const codes = Array.from({ length: 10 }, () =>
    randomBytes(16).toString("hex").match(/.{8}/g)!.join("-"),
  );
  await tx.query("DELETE FROM hc_recovery_codes WHERE user_id=$1", [userId]);
  await tx.query(
    "INSERT INTO hc_recovery_codes(user_id,code_hash) SELECT $1,unnest($2::text[])",
    [userId, codes.map((code) => recoveryHash(userId, code))],
  );
  return codes;
}
export async function securityNotice(
  tx: Database,
  userId: string,
  action: string,
  text: string,
) {
  const id = randomUUID();
  await tx.query(
    "INSERT INTO hc_notifications(id,owner_id,type,body,dedup_key) VALUES($1,$2,'security',$3,$4)",
    [id, userId, { action, text }, "security:" + id],
  );
}
