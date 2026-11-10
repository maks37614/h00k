import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { Dir } from "node:fs";
import path from "node:path";
import type { Database } from "./db";
import type { Account } from "./session";
import { fail, tokenHash, uuid } from "./security";
import { policy } from "./content";
import { retireProfileName } from "./profileNames";

export const mediaRoot = () =>
  process.env.COMMUNITY_MEDIA_DIR ??
  path.resolve("server/data/community-media");
let sweep: { root: string; directory: Dir } | undefined;
export async function closeMediaSweep() {
  const current = sweep;
  sweep = undefined;
  if (current) await current.directory.close().catch(() => {});
}
async function removeOrphanMedia(db: Database) {
  const root = mediaRoot();
  if (sweep && sweep.root !== root) await closeMediaSweep();
  if (!sweep) {
    try {
      sweep = { root, directory: await fs.opendir(root) };
    } catch (error: any) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
  try {
    for (let i = 0; i < 25; i++) {
      const entry = await sweep.directory.read();
      if (!entry) {
        await closeMediaSweep();
        break;
      }
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.webp$/i.test(entry.name))
        continue;
      const id = uuid(entry.name.slice(0, -5)),
        file = path.join(root, entry.name);
      let stat;
      try {
        stat = await fs.lstat(file);
      } catch (error: any) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || Date.now() - stat.mtimeMs < 3600_000) continue;
      const linked = await db.query(
        "SELECT id FROM hc_media WHERE id=$1 UNION ALL SELECT id FROM hc_media_cleanup WHERE id=$1",
        [id],
      );
      if (!linked.rows.length) await fs.rm(file, { force: true });
    }
  } catch (error) {
    await closeMediaSweep();
    throw error;
  }
}
const jsonLine = (section: string, record: unknown) =>
  JSON.stringify({ section, record }) + "\n";
const sections = [
  {
    name: "profile_address", table: "hc_profile_names", where: "owner_id=$1",
    key: "username", columns: "username,claimed_at",
  },
  {
    name: "archives",
    table: "hc_archives",
    where: "owner_id=$1",
    key: "id",
    columns: "id,body,created_at",
  },
  {
    name: "items",
    table: "hc_items",
    where: "owner_id=$1 AND NOT deleted",
    key: "id::text",
    columns: "*",
  },
  {
    name: "versions",
    table: "hc_item_versions",
    where:
      "item_id IN (SELECT id FROM hc_items WHERE owner_id=$1 AND NOT deleted)",
    key: "item_id::text||':'||revision::text",
    columns: "*",
  },
  {
    name: "charts",
    table: "hc_charts c JOIN hc_packs p ON p.hash=c.pack_hash",
    where: "c.owner_id=$1 AND NOT c.deleted",
    key: "c.id::text",
    columns: "c.id,c.parent_id,c.annotations,c.created_at,p.data AS candles",
  },
  {
    name: "friendships",
    table: "hc_friendships",
    where: "sender=$1 OR recipient=$1",
    key: "sender::text||':'||recipient::text",
    columns: "*",
  },
  {
    name: "blocks",
    table: "hc_blocks",
    where: "owner_id=$1",
    key: "target_id::text",
    columns: "*",
  },
  {
    name: "memberships",
    table: "hc_members",
    where: "user_id=$1",
    key: "conversation_id::text",
    columns: "*",
  },
  {
    name: "conversations",
    table: "hc_conversations",
    where: "id IN (SELECT conversation_id FROM hc_members WHERE user_id=$1)",
    key: "id::text",
    columns: "*",
  },
  {
    name: "reactions",
    table: "hc_reactions",
    where: "user_id=$1",
    key: "item_id::text",
    columns: "*",
  },
  {
    name: "connections",
    table: "hc_connections",
    where: "owner_id=$1",
    key: "id::text",
    columns: "id,exchange,status,synced_at,covered_from,error_code,created_at",
  },
  {
    name: "trades",
    table: "hc_trades",
    where: "owner_id=$1",
    key: "connection_id::text||':'||source_id",
    columns: "*",
  },
  {
    name: "trade_notes",
    table: "hc_trade_notes",
    where: "owner_id=$1",
    key: "connection_id::text||':'||source_id",
    columns: "*",
  },
  {
    name: "notifications",
    table: "hc_notifications",
    where: "owner_id=$1",
    key: "id::text",
    columns: "id,type,body,read_at,created_at",
  },
  {
    name: "reports",
    table: "hc_reports",
    where: "reporter_id=$1",
    key: "id::text",
    columns: "id,item_id,target_id,reason,status,resolution,created_at",
  },
  {
    name: "reputation",
    table: "hc_reputation",
    where: "owner_id=$1",
    key: "event_key",
    columns: "*",
  },
  {
    name: "media",
    table: "hc_media",
    where: "owner_id=$1",
    key: "id::text",
    columns: "*",
  },
] as const;

/** Bounded keyset pages and one image at a time. No exchange access or credential exports. */
export async function* accountExport(
  db: Database,
  account: Account,
  signal?: AbortSignal,
) {
  const startedAt = new Date().toISOString();
  const alive = async () => {
    if (signal?.aborted) throw new Error("Export cancelled");
    const live = await db.query(
      "SELECT u.id FROM hc_users u JOIN hc_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at>now() AND u.deleted_at IS NULL",
      [account.id, account.tokenHash],
    );
    if (!live.rows.length) fail("Сеанс експорту відкликано", 401);
  };
  await alive();
  yield jsonLine("manifest", {
    format: "h00k-personal-data",
    version: 1,
    startedAt,
    scope: "community",
    consistency: "Live paginated copy; records can change during export",
    excludes: [
      "password hashes",
      "session tokens",
      "MFA secrets",
      "recovery codes",
      "exchange credentials",
      "other authors' messages",
      "market-service data (separate export)",
    ],
  });
  const own = await db.query(
    "SELECT email,email_verified,profile,created_at FROM hc_users WHERE id=$1 AND deleted_at IS NULL",
    [account.id],
  );
  const profile = { ...own.rows[0].profile };
  delete profile.telegramBotToken;
  yield jsonLine("account", { ...own.rows[0], profile, id: account.id });
  let omitted = 0,
    records = 1;
  for (const section of sections) {
    let cursor = "";
    for (;;) {
      await alive();
      const { rows } = await db.query(
        `SELECT ${section.columns},${section.key} AS _export_key FROM ${section.table} WHERE (${section.where}) AND ${section.key}>$2 ORDER BY ${section.key} LIMIT 50`,
        [account.id, cursor],
      );
      const rules = await policy(db, account.id);
      for (const raw of rows) {
        const { _export_key, ...record } = raw;
        if (
          section.name === "charts" &&
          !(await rules.canReadChart(record.id))
        ) {
          omitted++;
          continue;
        }
        if (
          section.name === "items" &&
          (!(await rules.visible(record as any)) ||
            (record.chart_id && !(await rules.canReadChart(record.chart_id))))
        ) {
          omitted++;
          continue;
        }
        if (section.name === "versions") {
          const parent = await rules.item(record.item_id);
          if (
            !(await rules.visible(parent)) ||
            (parent?.chart_id && !(await rules.canReadChart(parent.chart_id)))
          ) {
            omitted++;
            continue;
          }
        }
        if (
          section.name === "archives" &&
          record.body?.sourceChartId &&
          !(await rules.canReadChart(record.body.sourceChartId))
        ) {
          omitted++;
          continue;
        }
        if (section.name === "media") {
          await alive();
          const file = path.join(mediaRoot(), uuid(record.id) + ".webp");
          const stat = await fs.lstat(file);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > 6 * 1024 * 1024
          )
            throw new Error("Invalid export media");
          const bytes = await fs.readFile(file);
          yield jsonLine("media", {
            ...record,
            mimeType: "image/webp",
            encoding: "base64",
            data: bytes.toString("base64"),
          });
        } else yield jsonLine(section.name, record);
        records++;
      }
      if (rows.length < 50) break;
      cursor = rows.at(-1)!._export_key;
    }
  }
  await alive();
  const risk = await db.query(
    "SELECT * FROM hc_risk_policies WHERE owner_id=$1",
    [account.id],
  );
  if (risk.rows[0]) yield jsonLine("risk_policy", risk.rows[0]);
  yield jsonLine("complete", {
    startedAt,
    finishedAt: new Date().toISOString(),
    records,
    omittedUnavailableSources: omitted,
  });
}

/** Caller holds the account row lock and has freshly verified password + configured factor. */
export async function deleteAccountData(tx: Database, owner: string) {
  const current = await tx.query(
    "SELECT id FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
    [owner],
  );
  if (!current.rows.length) fail("Акаунт уже видалено", 404);
  await retireProfileName(tx, owner);
  const groups = await tx.query(
    "SELECT id FROM hc_conversations WHERE owner_id=$1 FOR UPDATE",
    [owner],
  );
  for (const group of groups.rows) {
    const next = await tx.query(
      "SELECT user_id FROM hc_members WHERE conversation_id=$1 AND user_id<>$2 ORDER BY (role='admin') DESC,joined_at,user_id LIMIT 1 FOR UPDATE",
      [group.id, owner],
    );
    if (next.rows.length) {
      await tx.query("UPDATE hc_conversations SET owner_id=$2 WHERE id=$1", [
        group.id,
        next.rows[0].user_id,
      ]);
      await tx.query(
        "UPDATE hc_members SET role='owner' WHERE conversation_id=$1 AND user_id=$2",
        [group.id, next.rows[0].user_id],
      );
    } else
      await tx.query(
        "UPDATE hc_conversations SET title='Закрита розмова' WHERE id=$1",
        [group.id],
      );
  }
  await tx.query(
    "INSERT INTO hc_account_cleanup(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
    [owner],
  );
  await tx.query(
    "INSERT INTO hc_media_cleanup(id,owner_id) SELECT id,owner_id FROM hc_media WHERE owner_id=$1 ON CONFLICT DO NOTHING",
    [owner],
  );
  await tx.query("DELETE FROM hc_media WHERE owner_id=$1", [owner]);
  await tx.query(
    "DELETE FROM hc_item_versions WHERE item_id IN (SELECT id FROM hc_items WHERE owner_id=$1)",
    [owner],
  );
  await tx.query(
    "DELETE FROM hc_reactions WHERE user_id=$1 OR item_id IN (SELECT id FROM hc_items WHERE owner_id=$1)",
    [owner],
  );
  await tx.query(
    "UPDATE hc_items SET body='{}',deleted=true,revision=revision+1,updated_at=now() WHERE owner_id=$1",
    [owner],
  );
  const empty = tokenHash("h00k-deleted-chart");
  await tx.query(
    "INSERT INTO hc_packs(hash,data) VALUES($1,'{}') ON CONFLICT DO NOTHING",
    [empty],
  );
  await tx.query(
    "UPDATE hc_charts SET annotations='{}',preview='{}',pack_hash=$2,deleted=true WHERE owner_id=$1",
    [owner, empty],
  );
  for (const table of [
    "hc_trade_notes",
    "hc_trades",
    "hc_connections",
    "hc_archives",
    "hc_risk_state",
    "hc_risk_policies",
    "hc_notifications",
    "hc_reputation",
  ]) {
    await tx.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
  }
  await tx.query("DELETE FROM hc_friendships WHERE sender=$1 OR recipient=$1", [
    owner,
  ]);
  await tx.query("DELETE FROM hc_blocks WHERE owner_id=$1 OR target_id=$1", [
    owner,
  ]);
  await tx.query("DELETE FROM hc_members WHERE user_id=$1", [owner]);
  await tx.query(
    "UPDATE hc_reports SET reason='[видалено автором]' WHERE reporter_id=$1",
    [owner],
  );
  await tx.query("DELETE FROM hc_recovery_codes WHERE user_id=$1", [owner]);
  await tx.query("DELETE FROM hc_tokens WHERE user_id=$1", [owner]);
  await tx.query("DELETE FROM hc_sessions WHERE user_id=$1", [owner]);
  await tx.query("UPDATE hc_audit SET details='{}' WHERE actor_id=$1", [owner]);
  await tx.query(
    "UPDATE hc_users SET email=$2,email_verified=false,password_hash=$3,profile='{}',mfa_secret=NULL,mfa_pending=NULL,mfa_last_counter=-1,deleted_at=now() WHERE id=$1",
    [
      owner,
      "deleted+" + owner + "@account.invalid",
      randomBytes(32).toString("hex"),
    ],
  );
}

/** Disk cleanup is retryable and separate from immediate access/credential revocation. */
export async function cleanupAccountMedia(db: Database, limit = 20) {
  const { rows } = await db.query(
    "SELECT id FROM hc_media_cleanup ORDER BY created_at,id LIMIT $1",
    [Math.min(50, Math.max(1, limit))],
  );
  let completed = 0;
  for (const row of rows) {
    await fs.rm(path.join(mediaRoot(), uuid(row.id) + ".webp"), {
      force: true,
    });
    await db.query("DELETE FROM hc_media_cleanup WHERE id=$1", [row.id]);
    completed++;
  }
  await db.query("DELETE FROM hc_export_tickets WHERE expires_at<=now()");
  await removeOrphanMedia(db);
  return completed;
}
