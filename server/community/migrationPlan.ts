import { createHash } from "node:crypto";
import type { Database } from "./db";
import { normalizeChartDocument } from "../../src/community/chartDocument";

export interface MigrationBundle {
  version: 1;
  accounts: Array<{ legacyId: string; nativeId: string }>;
  profiles: Array<{ ownerId: string; data: Record<string, unknown> }>;
  archives: Array<{
    ownerId: string;
    id: string;
    data: Record<string, unknown>;
  }>;
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function object(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function id(v: unknown) {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 150 &&
    v === v.trim() &&
    !/[\u0000-\u001f]/.test(v)
  );
}
const sensitive = new Set([
  "password",
  "passwordhash",
  "mfasecret",
  "mfapending",
  "bottoken",
  "telegrambottoken",
  "apikey",
  "apisecret",
  "credential",
  "privatekey",
]);
function unsafe(value: unknown, depth = 0): boolean {
  if (depth > 25) return true;
  if (Array.isArray(value)) return value.some((v) => unsafe(v, depth + 1));
  if (object(value))
    return Object.entries(value).some(
      ([key, v]) =>
        sensitive.has(key.toLowerCase().replace(/_/g, "")) ||
        unsafe(v, depth + 1),
    );
  return false;
}
/** Explicit owner mapping only. Never infer identity from matching email or names. */
export function validateMigrationBundle(raw: unknown) {
  if (
    !object(raw) ||
    raw.version !== 1 ||
    ![raw.accounts, raw.profiles, raw.archives].every(Array.isArray)
  )
    throw new Error("Unsupported migration bundle");
  const errors: string[] = [],
    mappings = new Map<string, string>(),
    targets = new Set<string>();
  const error = (kind: string, index: number, code: string) =>
    errors.push(`${kind}[${index}]: ${code}`);
  for (const [i, a] of raw.accounts.entries()) {
    if (
      !object(a) ||
      !id(a.legacyId) ||
      typeof a.nativeId !== "string" ||
      !uuid.test(a.nativeId)
    ) {
      error("accounts", i, "invalid_identity");
      continue;
    }
    const native = a.nativeId.toLowerCase();
    if (mappings.has(a.legacyId) || targets.has(native)) {
      error("accounts", i, "duplicate_mapping");
      continue;
    }
    mappings.set(a.legacyId, native);
    targets.add(native);
  }
  const profiles = new Set<string>(),
    archives = new Set<string>();
  function owner(row: any, kind: string, i: number) {
    if (!object(row) || !id(row.ownerId) || !mappings.has(row.ownerId)) {
      error(kind, i, "unmapped_owner");
      return false;
    }
    if (!object(row.data)) {
      error(kind, i, "invalid_data");
      return false;
    }
    if (row.data.uid !== undefined && row.data.uid !== row.ownerId)
      error(kind, i, "conflicting_uid");
    if (row.data.userId !== undefined && row.data.userId !== row.ownerId)
      error(kind, i, "conflicting_owner");
    return true;
  }
  for (const [i, row] of raw.profiles.entries()) {
    if (!owner(row, "profiles", i)) continue;
    if (profiles.has(row.ownerId)) error("profiles", i, "duplicate_profile");
    profiles.add(row.ownerId);
    // These are not profile preferences and must never enter a migration payload.
    if (unsafe(row.data)) error("profiles", i, "credential_material");
    if (
      row.data.watchlist !== undefined &&
      (!Array.isArray(row.data.watchlist) ||
        row.data.watchlist.length > 2000 ||
        row.data.watchlist.some(
          (v: any) => typeof v !== "string" || v.length > 100,
        ))
    )
      error("profiles", i, "invalid_watchlist");
  }
  for (const [i, row] of raw.archives.entries()) {
    if (!owner(row, "archives", i)) continue;
    if (unsafe(row.data)) error("archives", i, "credential_material");
    if (!id(row.id) || !/^arch_[\p{L}\p{M}\p{N}_-]+$/u.test(row.id)) {
      error("archives", i, "invalid_archive_id");
      continue;
    }
    const key = JSON.stringify([row.ownerId, row.id]);
    if (archives.has(key)) error("archives", i, "duplicate_archive");
    archives.add(key);
    if (row.data.id !== undefined && row.data.id !== row.id)
      error("archives", i, "conflicting_archive_id");
    if (row.data.sourceChartId !== undefined)
      error("archives", i, "unresolved_native_chart_reference");
    if (row.data.chartDocument)
      try {
        normalizeChartDocument(row.data.chartDocument);
      } catch {
        error("archives", i, "invalid_chart_snapshot");
      }
    if (
      !object(row.data.formation) ||
      !object(row.data.formation.levels) ||
      typeof row.data.formation.name !== "string" ||
      typeof row.data.symbol !== "string" ||
      !row.data.symbol ||
      !["binance", "bybit"].includes(row.data.exchange) ||
      !["spot", "futures"].includes(row.data.marketType) ||
      !["1m", "5m", "15m", "1h", "4h", "1d"].includes(row.data.timeframe) ||
      !Number.isFinite(row.data.savedAtTimestamp) ||
      row.data.savedAtTimestamp <= 0
    )
      error("archives", i, "incomplete_archive");
  }
  return {
    valid: errors.length === 0,
    counts: {
      accounts: raw.accounts.length,
      profiles: raw.profiles.length,
      archives: raw.archives.length,
    },
    errors,
    mappings,
  };
}
/** SELECT only, bounded batches; detects missing/deleted targets and overwrite conflicts. */
export async function checkMigrationTargets(
  db: Database,
  bundle: MigrationBundle,
) {
  const plan = validateMigrationBundle(bundle);
  if (!plan.valid) return { ...plan, targetErrors: [] as string[] };
  const targetErrors: string[] = [];
  const ids = [...plan.mappings.values()];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const { rows } = await db.query(
      "SELECT id,deleted_at FROM hc_users WHERE id=ANY($1::uuid[])",
      [batch],
    );
    const live = new Set(rows.filter((r) => !r.deleted_at).map((r) => r.id));
    for (const native of batch)
      if (!live.has(native))
        targetErrors.push(
          `accounts[${ids.indexOf(native)}]: missing_or_deleted_target`,
        );
  }
  for (let i = 0; i < bundle.archives.length; i += 100) {
    const batch = bundle.archives.slice(i, i + 100);
    const owners = batch.map((r) => plan.mappings.get(r.ownerId)!);
    const { rows } = await db.query(
      "SELECT owner_id,id FROM hc_archives WHERE owner_id=ANY($1::uuid[]) AND id=ANY($2::text[])",
      [owners, batch.map((r) => r.id)],
    );
    const existing = new Set(
      rows.map((r) => JSON.stringify([r.owner_id, r.id])),
    );
    batch.forEach((r, j) => {
      if (existing.has(JSON.stringify([owners[j], r.id])))
        targetErrors.push(`archives[${i + j}]: target_already_exists`);
    });
  }
  return { ...plan, valid: targetErrors.length === 0, targetErrors };
}
export const bundleDigest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
