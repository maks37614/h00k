# Identity migration preflight

This tool validates a deliberately normalized migration bundle. It does not read Firebase, create accounts, activate a password, link identities, rewrite market files or import any data. It has no apply mode. A successful report means the checked structural conditions passed, not that identity ownership has been proven or the migration is complete.

Prepare a trusted server-side export and an explicitly reviewed one-to-one legacy-ID → native-UUID mapping. Verify ownership through the authenticated legacy account or another approved recovery process. Matching email/name is never sufficient. Do not put exports or identity maps into Git, images, public links or issue comments. `migration-input/` and `migration-reports/` are ignored by Git and Docker.

Normalized input contract:

```json
{
  "version": 1,
  "accounts": [{"legacyId": "legacy-owner", "nativeId": "11111111-1111-4111-8111-111111111111"}],
  "profiles": [{"ownerId": "legacy-owner", "data": {"uid": "legacy-owner", "watchlist": []}}],
  "archives": []
}
```

Archive entries use `{ownerId, id, data}`, with the complete existing `ArchivedFormation` payload in `data`. Firebase export files are not this format: flatten them into these explicit arrays first, preserving exact IDs and preferences. This revision does not provide a raw Firestore export decoder. Legacy snapshots without candle documents are allowed; existing native chart references require a separate, reviewed ancestry mapping and are rejected here.

Run locally, without a database:

```sh
npm run community:migration-plan -- migration-input/normalized.json
```

Optionally check an already prepared **staging** PostgreSQL target:

```sh
npm run community:migration-plan -- migration-input/normalized.json --check-target
```

Target checking executes SELECT statements only, in bounded batches. It rejects missing/deleted native targets and conflicting archive IDs. It does not compare or overwrite existing target profile settings. Use a database role restricted to SELECT for this preflight. The schema must already exist.

Reports contain counts, exact-input SHA-256, index-based issue codes and whether the target was checked. They omit account IDs, emails, payloads, credentials and paths. Exit code 0 indicates checked conditions passed; 1 means invalid input/target or a read failure; 2 means invalid command usage. Inputs above 20 MiB are rejected; split large exports into separately fingerprinted bundles while reviewing the global identity mapping independently.

Before any write-capable importer is introduced, review the trusted export, global identity mapping and reports; decide conflict handling and password enrollment, inventory market-side owner records, and rehearse backup/rollback/deletion-ledger replay. A later importer must use the reviewed input fingerprint, be transactional/idempotent, preserve chart ancestry and never silently merge accounts by email. No production migration has been performed by adding this preflight.
