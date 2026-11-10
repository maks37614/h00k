import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  validateMigrationBundle,
  checkMigrationTargets,
  bundleDigest,
} from "../server/community/migrationPlan";
function bundle() {
  return {
    version: 1 as const,
    accounts: [{ legacyId: "legacy-owner", nativeId: randomUUID() }],
    profiles: [
      {
        ownerId: "legacy-owner",
        data: { uid: "legacy-owner", watchlist: ["binance:futures:BTCUSDT"] },
      },
    ],
    archives: [
      {
        ownerId: "legacy-owner",
        id: "arch_saved",
        data: {
          symbol: "BTCUSDT",
          formation: {
            name: "Example",
            levels: { entryPrice: 100, targetPrice: 110, stopLossPrice: 90 },
          },
          exchange: "binance",
          marketType: "futures",
          timeframe: "1h",
          savedAtTimestamp: Date.now(),
        },
      },
    ],
  };
}
test("migration planning requires explicit one-to-one identities and never joins by email", () => {
  const b = bundle();
  assert.equal(validateMigrationBundle(b).valid, true);
  b.accounts.push({ ...b.accounts[0], legacyId: "other" });
  assert.equal(validateMigrationBundle(b).valid, false);
  assert.throws(() =>
    validateMigrationBundle({ version: 1, profiles: [], archives: [] }),
  );
  const missing = bundle();
  missing.accounts = [];
  assert.ok(
    validateMigrationBundle(missing).errors.some((v) =>
      v.includes("unmapped_owner"),
    ),
  );
});
test("migration reports reject conflicting owners and secret material without echoing it", () => {
  const b = bundle();
  (b.profiles[0].data as any).password = "do-not-log-this";
  (b.archives[0].data as any).userId = "other-owner";
  const plan = validateMigrationBundle(b);
  assert.equal(plan.valid, false);
  assert.ok(plan.errors.some((v) => v.endsWith("credential_material")));
  assert.ok(!JSON.stringify(plan.errors).includes("do-not-log-this"));
});
test("legacy archives must be complete and native chart ancestry cannot be silently dropped", () => {
  const b = bundle();
  (b.archives[0].data as any).sourceChartId = randomUUID();
  assert.equal(validateMigrationBundle(b).valid, false);
  delete (b.archives[0].data as any).sourceChartId;
  b.archives.push(b.archives[0]);
  assert.ok(
    validateMigrationBundle(b).errors.some((v) =>
      v.endsWith("duplicate_archive"),
    ),
  );
});
test("target preflight is SELECT-only and refuses missing accounts or existing archive IDs", async () => {
  const b = bundle(),
    queries: string[] = [];
  const db: any = {
    query: async (sql: string) => {
      queries.push(sql);
      return {
        rows: sql.includes("hc_users")
          ? [{ id: b.accounts[0].nativeId, deleted_at: null }]
          : [{ owner_id: b.accounts[0].nativeId, id: "arch_saved" }],
      };
    },
    transaction: () =>
      assert.fail("planner must never start write transactions"),
  };
  const result = await checkMigrationTargets(db, b);
  assert.equal(result.valid, false);
  assert.ok(result.targetErrors[0].includes("target_already_exists"));
  assert.ok(queries.every((sql) => sql.startsWith("SELECT ")));
  db.query = async () => ({ rows: [] });
  assert.ok(
    (await checkMigrationTargets(db, b)).targetErrors.some((v) =>
      v.includes("missing_or_deleted_target"),
    ),
  );
});
test("bundle fingerprints change with the exact input bytes", () => {
  assert.equal(bundleDigest(Buffer.from("a")), bundleDigest(Buffer.from("a")));
  assert.notEqual(
    bundleDigest(Buffer.from("a")),
    bundleDigest(Buffer.from("a\n")),
  );
});
