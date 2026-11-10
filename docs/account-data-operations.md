# Account security and personal-data operations

This revision adds account controls to the existing draft Community PR. It has not deleted or exported production users, applied a production migration or deployed the branch.

## Authentication and recovery

- Argon2id passwords and hashed opaque cookie sessions remain the primary account credentials. Existing active native sessions receive a safe UUID for session management.
- TOTP accepts the normal adjacent time windows but atomically records the highest accepted counter. A second request cannot reuse a consumed counter. Keep service clocks synchronized.
- MFA confirmation issues ten independently random 128-bit recovery codes. Only owner-scoped SHA-256 hashes are stored. Plain codes appear once in the confirmation/regeneration response and stay only in component memory until hidden or the page closes; downloading them is a deliberate local action.
- Recovery codes can substitute for a missing authenticator during login, password recovery or a fresh factor check. They do not substitute for the password during login, export, deletion or factor replacement. Regeneration invalidates the old set; disabling MFA invalidates all recovery codes.
- A pending factor is encrypted, expires after fifteen minutes and is tied to the initiating session and previous factor. Another session cannot confirm it. Confirmation revokes the other sessions.
- Changing a password rotates the cookie, revokes old sessions and reset tokens, and clears pending factor enrollment. Password recovery revokes all sessions and retains the active second factor.
- Security events enter the private inbox. A security banner is secondary to risk-limit alerts. Codes, passwords and connector credentials never appear in notifications.
- Sensitive actions are rate-limited by account and IP. Production still needs distributed ingress limits and operational review of lockout/recovery handling. No email-only MFA bypass or support impersonation shortcut exists.

These choices follow the recovery and factor-change considerations in the [OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html) and [password-recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html). They are not a claim of phishing resistance or completed security certification.

## Export

`POST /api/account/export` freshly verifies the password and configured factor, and selects the `community` or `market` scope. It returns an authenticated download URL backed by a random, hashed, ten-minute, one-use ticket. The ticket also requires the same session and scope. Another account/session, replay, expiry and a revoked cookie cannot download it. HEAD is rejected without consuming a ticket.

| File | Contents |
| --- | --- |
| Community JSONL.gz | Own profile, available authored items/versions/charts/archives, relationships, conversation metadata, reactions, connector metadata, imported trades/notes, notifications, reports, milestones, risk policy and own sanitized images as base64 records. |
| Market JSONL.gz | Own price alerts, alert history, surveillance, Telegram connection metadata and recorded message deliveries. |
| Excluded | Password hashes, cookie tokens/hashes, MFA secrets, recovery codes, exchange credentials, global bot tokens, pending Telegram linking codes and other authors' message bodies. |

Community uses keyset pages of fifty records, checks that the session is still live between pages, and reads one bounded image at a time. Source access is checked again; exporting cannot reopen a revoked source. An ending `complete` record indicates completion. The manifest includes start/end times and the number of unavailable-source omissions. This is a live paginated copy; concurrent changes are possible. It is not an atomic restore image of the database. Do not use it as the operator's only backup.

The download uses gzip as its file format, without the HTTP `Content-Encoding` header, so browsers save the compressed file. The same-origin compatibility proxy forwards the stream and attachment headers with backpressure; it does not copy a large archive into one buffer. Community allows two active exports in total and one per owner. Stream lifetime is bounded to five minutes. A failed or interrupted export must be requested again with fresh credentials.

## Deletion

The interface previews affected record counts and requires the literal `DELETE`, the current password and the configured factor. No deletion happens from viewing the preview. All of the following database changes commit together, and the API acknowledges success only after commit:

1. Revoke sessions, export tickets, verification/reset tokens and recovery codes.
2. Erase connector credentials/connections, trades, trade notes, risk state/policies, archives, private inbox and personal milestone rows.
3. Scrub the author's item bodies, revisions, reactions and chart annotations/previews; mark items/charts deleted so descendants become unavailable.
4. Remove profile/email/password/MFA data. Keep a minimal, non-login tombstone UUID for foreign-key integrity. Reports/audit records retain minimal identifiers and event metadata; the deleted author's report reasons/audit details are scrubbed.
5. Remove friendships, blocks and memberships. Shared conversations transfer to their oldest remaining admin, then oldest member. Other authors' messages stay theirs. Empty owned conversations have a generic title.
6. Queue disk-media deletion and market-service cleanup before erasing media metadata.

This does not call an exchange key-management endpoint. The encrypted secret is removed from h00k storage; the user must revoke the read-only key at the exchange. A request already sent to an external service or a copy already downloaded cannot be recalled by this transaction.

Community mutations hold a short owner lock. Connector HTTP work runs outside that lock; each persistence batch rechecks the live account. Upload metadata and risk events have the same protection. Cookie authentication and native-UUID service tokens reject the deleted account immediately; a durable market tombstone also prevents old filesystem writes from recreating it after cleanup.

## Cleanup workers

| Worker | Behavior |
| --- | --- |
| Community, every five seconds | Removes at most twenty queued image files, acknowledges completed removals, and prunes expired export tickets. It scans at most twenty-five media directory entries per pass for interrupted-upload orphans older than an hour. Linked/recent files are retained. |
| Market, every fifteen seconds | Claims at most two deleted-account jobs with leases; removes Telegram connection/link/delivery records, price alerts/history and surveillance records/workers. Interrupted work retries after the lease/backoff; completed jobs are idempotent. It makes no exchange request. |

Both services must reach the same PostgreSQL database; only the market worker touches the established market data volume. The Community service touches its own private media volume. If either volume/service is unavailable, the durable job remains pending. Cookie access and credential erasure do not wait for disk cleanup.

The operator must monitor pending/failed cleanup and handle volume restoration deliberately. These read-only queries show backlog without exposing account content or secrets:

```sql
SELECT count(*) AS pending_market_jobs,
       min(created_at) AS oldest_pending,
       max(attempts) AS maximum_attempts
FROM hc_account_cleanup WHERE market_pending;

SELECT count(*) AS pending_images, min(created_at) AS oldest_pending
FROM hc_media_cleanup;
```

Downloaded copies and already delivered Telegram messages are outside this erasure workflow. Backups, logs, pseudonymous tombstones and moderation metadata require published retention rules. Before restoring an older backup, replay the subsequent deletion ledger so deleted profiles/credentials are not resurrected. The ledger and its operational custody/retention are a release requirement, not solved by keeping this branch draft.

## Staging acceptance

Before upgrading a staging database, take an operator backup and run `npm run community:migrate`; then start both service revisions with their correct volumes. Native-account deletion/export assumes identity and legacy-owner mapping has already been completed correctly.

Verify on staging:

- Clock skew, simultaneous TOTP/recovery use, enrollment from another session, lost-factor recovery, password resets and cookie revocation on real devices.
- SMTP delivery and retry behavior. Password-reset delivery is asynchronous best effort in the current process; a durable mail outbox and delivery monitoring remain follow-up work for production reliability.
- Large downloads through the actual edge proxy, disconnect cancellation, no credential leakage, scope/session isolation and five-minute limits.
- Actual PostgreSQL pooling/locks/savepoints and interrupted cleanup on both volumes. Embedded PostgreSQL tests cover SQL behavior; they do not certify the deployed network/pool.
- Account deletion while sync/upload/notifications run, group-owner transfer and access revocation through all supported authentication paths.
- Backup restoration with deletion replay, retention schedules, user-facing disclosures, localization and moderator procedures.
- Browser/mobile layout and keyboard/password-manager flow. The managed preview relay remains unavailable in this environment, so visual browser QA is unverified.

Keep production egress disabled and the PR draft until the migration, infrastructure, operational and joint market/Community load checks in `community-architecture.md` are satisfied.
