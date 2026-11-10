import { createHash } from "node:crypto";
import type { Database } from "./db";
import { fail } from "./security";

export const NAME_CHANGE_INTERVAL = 30 * 86400_000;
const reserved = new Set([
  "admin", "administrator", "support", "help", "api", "auth", "account",
  "accounts", "login", "register", "www", "mail", "webmail", "smtp", "imap",
  "pop", "pop3", "ftp", "sftp", "ssh", "dns", "ns1", "ns2", "autodiscover",
  "autoconfig", "stage", "staging", "test", "dev", "prod", "production",
  "community", "community-stage", "app", "assets", "static", "cdn", "media",
  "images", "files", "ws", "status", "ops", "metrics", "database", "postgres",
  "billing", "payments", "security", "abuse", "moderator", "official", "h00k", "hook",
]);
export function profileName(input: unknown): string {
  if (typeof input !== "string" || input.length > 60) fail("Некоректне ім’я профілю");
  const name = input.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(name))
    fail("Ім’я: 3–30 латинських літер, цифр або дефісів; перший символ — літера, останній — літера чи цифра");
  if (reserved.has(name) || /^(xn--|h00k-|hook-|(?:admin|support|security|official|moderator|billing|payments)(?:-|[0-9]))/.test(name))
    fail("Це ім’я зарезервоване сервісом", 409);
  return name;
}
export const profileNameHash = (name: string) =>
  createHash("sha256").update("h00k-profile-name:" + name).digest("hex");

export function profileDomain(): string | null {
  const domain = process.env.COMMUNITY_PROFILE_DOMAIN?.trim().toLowerCase();
  if (!domain) return null;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))
    fail("Некоректний COMMUNITY_PROFILE_DOMAIN", 503);
  return domain;
}
/** Never use forwarded host headers or an unvalidated Host to construct links. */
export function nameFromHost(host: unknown, domain = profileDomain()): string | null {
  if (typeof host !== "string" || !domain || /[\s,/@\\]/.test(host)) return null;
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  if (!hostname.endsWith("." + domain)) return null;
  const label = hostname.slice(0, -domain.length - 1);
  try { return profileName(label); } catch { return null; }
}
export function communityOrigin(): string {
  const origin = new URL(process.env.APP_ORIGIN || "http://localhost:3000");
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password ||
      !(origin.protocol === "https:" || (process.env.NODE_ENV !== "production" && origin.protocol === "http:")))
    fail("Некоректний APP_ORIGIN", 503);
  return origin.origin;
}
export function publicProfileUrl(name: string): string {
  const domain = profileDomain();
  return domain ? `https://${name}.${domain}` : `${communityOrigin()}/u/${name}`;
}
export async function ownProfileName(db: Database, owner: string) {
  const { rows } = await db.query(
    "SELECT username,claimed_at FROM hc_profile_names WHERE owner_id=$1", [owner],
  );
  const row = rows[0];
  return {
    username: row?.username ?? null,
    url: row ? publicProfileUrl(row.username) : null,
    changeAllowedAt: row ? new Date(new Date(row.claimed_at).getTime() + NAME_CHANGE_INTERVAL).toISOString() : null,
  };
}
/** Call after credential verification and locking the owner, in that transaction. */
export async function claimProfileName(db: Database, owner: string, input: unknown, now = Date.now()) {
  const name = profileName(input);
  const current = await db.query("SELECT username,claimed_at FROM hc_profile_names WHERE owner_id=$1", [owner]);
  const row = current.rows[0];
  if (row?.username === name) return ownProfileName(db, owner);
  if (row && new Date(row.claimed_at).getTime() + NAME_CHANGE_INTERVAL > now)
    fail("Змінювати адресу можна раз на 30 днів", 409);
  // Retired names keep only an unowned digest. Old links are never assigned to another person.
  if (row) await retireProfileName(db, owner, now);
  const inserted = await db.query(
    "INSERT INTO hc_profile_names(name_hash,username,owner_id,claimed_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING username",
    [profileNameHash(name), name, owner, new Date(now)],
  );
  if (!inserted.rows.length) fail("Ім’я зайняте або більше не використовується", 409);
  return ownProfileName(db, owner);
}
export async function retireProfileName(db: Database, owner: string, now = Date.now()) {
  await db.query("UPDATE hc_profile_names SET username=NULL,owner_id=NULL,retired_at=$2 WHERE owner_id=$1", [owner, new Date(now)]);
}
