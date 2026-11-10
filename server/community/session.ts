import type { Request } from "express";
import type { Database } from "./db";
import { sessionCookie, tokenHash } from "./security";
export interface Account {
  id: string;
  email: string;
  email_verified: boolean;
  profile: any;
  mfa_secret: string | null;
  strong: boolean;
  tokenHash: string;
}
export async function accountFor(
  db: Database,
  req: Request,
): Promise<Account | null> {
  const token = sessionCookie(req);
  if (!token) return null;
  const hash = tokenHash(token);
  const { rows } = await db.query(
    `SELECT u.id,u.email,u.email_verified,u.profile,u.mfa_secret,
    (s.last_strong_auth > now()-interval '15 minutes') AS strong FROM hc_sessions s
    JOIN hc_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.deleted_at IS NULL`,
    [hash],
  );
  return rows[0] ? { ...rows[0], tokenHash: hash } : null;
}
