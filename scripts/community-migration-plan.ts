import "dotenv/config";
import fs from "node:fs/promises";
import { postgres, closeDatabase } from "../server/community/db";
import {
  validateMigrationBundle,
  checkMigrationTargets,
  bundleDigest,
  type MigrationBundle,
} from "../server/community/migrationPlan";
const args = process.argv.slice(2),
  file = args.find((v) => !v.startsWith("--"));
if (
  !file ||
  args.filter((v) => !v.startsWith("--")).length !== 1 ||
  args.some((v) => v.startsWith("--") && v !== "--check-target")
) {
  console.error(
    "Usage: npm run community:migration-plan -- <normalized-bundle.json> [--check-target]",
  );
  process.exitCode = 2;
} else {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
      throw new Error("Invalid or oversized bundle");
    const bytes = await fs.readFile(file),
      raw = JSON.parse(bytes.toString("utf8"));
    const validated = validateMigrationBundle(raw);
    const result =
      args.includes("--check-target") && validated.valid
        ? await checkMigrationTargets(postgres(), raw as MigrationBundle)
        : validated;
    // No emails, native/legacy IDs, payloads, paths or credentials enter the report.
    console.log(
      JSON.stringify(
        {
          version: 1,
          mode: "read-only",
          sha256: bundleDigest(bytes),
          valid: result.valid,
          counts: result.counts,
          errors: result.errors,
          targetErrors: "targetErrors" in result ? result.targetErrors : [],
          targetChecked: args.includes("--check-target") && validated.valid,
        },
        null,
        2,
      ),
    );
    if (!result.valid) process.exitCode = 1;
  } catch {
    console.error(
      "Cannot validate migration input. Check file format, size and target database configuration; input content was not logged.",
    );
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
