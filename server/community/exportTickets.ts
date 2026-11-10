import type { Database } from "./db";
import type { Account } from "./session";
import { bounded, fail, opaqueToken, tokenHash } from "./security";
export type ExportScope = "community" | "market";
export async function issueExportTicket(
  tx: Database,
  account: Account,
  scope: ExportScope,
) {
  const ticket = opaqueToken();
  await tx.query(
    "DELETE FROM hc_export_tickets WHERE owner_id=$1 AND scope=$2",
    [account.id, scope],
  );
  await tx.query(
    "INSERT INTO hc_export_tickets(token_hash,owner_id,session_hash,scope,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
    [tokenHash(ticket), account.id, account.tokenHash, scope],
  );
  return ticket;
}
export async function consumeExportTicket(
  db: Database,
  account: Account,
  raw: unknown,
  scope: ExportScope,
) {
  const ticket = bounded(raw, 60);
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket))
    fail("Посилання експорту недійсне", 404);
  const { rows } = await db.query(
    "DELETE FROM hc_export_tickets WHERE token_hash=$1 AND owner_id=$2 AND session_hash=$3 AND scope=$4 AND expires_at>now() RETURNING owner_id",
    [tokenHash(ticket), account.id, account.tokenHash, scope],
  );
  if (!rows.length) fail("Посилання експорту використане або прострочене", 404);
}
