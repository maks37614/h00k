# Community implementation and rollout

This change implements the first Community workspace on the existing h00k codebase. It reuses Replay, the formation archive, watchlist and HookChart canvas engine. It is prepared for review; it has not migrated production accounts, provisioned infrastructure or deployed to h00k.top.

## The chart journey

1. Enable TP/SL in the screener's chart toolbar. A chart without a detected setup can create an explicitly editable personal plan.
2. Drag Entry, TP, SL, other markers, drawing points or whole drawings. The shared scanner's detected formation is never mutated.
3. The archive icon captures the displayed candle window, current markers, drawings, timeframe and viewport. Existing formation callbacks receive that document; charts without a detected formation use the same archive endpoint with a personal analysis record.
4. Community's attachment picker reads the existing formation archive or watchlist. New archives use their captured document; old archives/watchlist entries request a seed only after selection.
5. A published chart is immutable. “Reply with my analysis” creates a branch referencing the parent; modifying lines and entry points never updates the parent chart or post.
6. Responses can be comments, private/group messages, a post on the author's wall, or another personal archive entry. Forwarding cannot broaden the source's permissions.

The minimal editor uses `hookchart/engine.tsx` directly. It does **not** mount `HookChartCanvas`'s live feed, profile writes, OI, order book, funding, liquidation or settings modules. It retains drawing tools, timeframes, date/history navigation, zoom, marker editing and undo.

## Network and storage budgets

| Action | Market/exchange traffic |
| --- | --- |
| Open archive list | Metadata only; no candle documents and no exchange request. |
| Render or scroll Community cards | Prepared previews stored with chart records; no canvas or exchange subscription. |
| Open comments | Authorized, paginated thread request only after expanding a post; the feed does not recursively load every thread. |
| Open an existing captured chart | One authorized document read from PostgreSQL; no exchange request. |
| Draw, drag, edit a label or undo | Local component state; no request and no profile write. |
| Change to a coarser timeframe already covered by the snapshot | Local aggregation, with incomplete/gapped buckets excluded. |
| Select unavailable timeframe or older history | Explicit request to a shared 500-bar block cache. Only a genuine miss can reach an exchange. |
| Another reader requests the same block | Reuse PostgreSQL cache; in-process coalescing and advisory lock across replicas. |
| Publish or fork | Store annotation metadata and reference a content-addressed candle pack; identical data packs are deduplicated. |

Time and price are the annotation coordinates. Candle timestamps are seconds in the canonical document and milliseconds only inside the drawing engine. Timeframes never manufacture finer data from coarser candles. Frozen source candles win over later history overlap; new historical frames exclude bars that were not closed by the snapshot cutoff. Descendants cannot alter parent candles: extensions must match saved history or a valid coarser aggregation.

The editor keeps a bounded working window, at most 2,000 bars per timeframe / 4,000 total, 100 markers and 200 drawings. Older history slides this window; “Back to snapshot” restores the captured window. The server limits cold history work to two concurrent keys and uses a PostgreSQL-coordinated outbound budget. No direct-browser exchange fallback is available in Community.

Cache access is separate from authorization. Public prices may be shared internally, while document, preview and media responses always check the requesting user's current ownership, friendship, source ancestry and chat membership. Removing friendship, narrowing a post's audience, leaving a chat or deleting a source changes subsequent access. Previously downloaded content cannot be remotely erased from a reader's own device.

## Isolated service

`server.ts` keeps the existing market routes and processes. Only `/api/account` and `/api/community` are proxied to `communityServer.ts`; missing Community infrastructure returns 503 for those routes and does not start a worker in the market process. Sensitive existing market actions use native sessions; market ticks do not query authentication.

The compatibility proxy caps Community concurrency at eight requests and bodies at 6 MB. For production, route these same-origin paths from the edge reverse proxy directly to the independent service, with ingress/body/rate limits. This keeps Community uploads and response copies out of the market Node process entirely.

Run Community and PostgreSQL with reserved resources, preferably a separate host. Separate containers on a saturated VPS do not establish a performance guarantee. Measure market latency/frame times with Community disabled and enabled before rollout.

`COMMUNITY_EXCHANGE_EGRESS_ISOLATED` defaults off. Enable it only after provisioning a separate egress IP or coordinating all exchange consumers on the shared IP. This includes private read APIs: separate processes do not create separate IP quotas. Do not enable the flag merely to dismiss an unavailable-history message.

## Native accounts and personal data

Firebase imports and runtime dependency are removed. Registration uses Argon2id, server-side hashed opaque sessions and HttpOnly/Secure cookies. Changes require the same-origin request header plus an allowed Origin; authenticated ownership is server derived. Sensitive connector operations require verified email and recent second-factor authentication (TOTP or a recovery code). Password recovery cannot bypass an active second factor. TOTP counters are consumed atomically; reuse of the same counter is rejected across sessions. Ten random single-use recovery codes are displayed once and stored only as owner-scoped hashes. Factor enrollment is bound to the initiating session and current factor; replacement, disabling, password changes, exports and deletion require fresh password/factor proof. The settings page lists safe session IDs, revokes individual sessions and supports sign-out everywhere. See [account-data-operations.md](account-data-operations.md) for the exact lifecycle and retention boundaries.

`COMMUNITY_ENCRYPTION_KEY` is a 32-byte base64 key provided through secret configuration, never Git. It encrypts MFA and connector secrets with AES-GCM and owner/connection associated data. Passwords use hashes. A read-only connector still has necessary machine access to its secret; this is not a zero-access or end-to-end-encrypted service. Back up and rotate the encryption key with a deliberate re-encryption/re-enrollment procedure.

Account privacy, archive rows, community content, conversations, memberships, source versions, media metadata, trades, risk policies, notifications and audit records are in PostgreSQL. Image bytes use a private persistent volume in this initial deployment; sanitized WebP is served only through authorized routes. Plan object-storage integration and lifecycle/deletion management before a large public launch.

Existing price-alert and surveillance server persistence remains in the market service's established data volume. Firebase mirrors are removed; those routes retain their server source of truth. **Legacy owner IDs must be migrated alongside PostgreSQL identity mapping.**

## Setup on a staging environment

Required configuration:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection for Community; use verified TLS for a remote database. |
| `COMMUNITY_INTERNAL_ORIGIN` | Reachable private/TLS Community origin for the market proxy; loopback `http://127.0.0.1:3001` for same-host staging. |
| `APP_ORIGIN` | Exact user-facing origin for verification/recovery links and CSRF checks. |
| `COMMUNITY_PUBLIC_ORIGINS` | Optional comma-separated exact additional frontend origins. |
| `COMMUNITY_ENCRYPTION_KEY` | Secret 32-byte base64 encryption key. |
| `SMTP_URL`, `MAIL_FROM` | Verification and recovery delivery; no delivery is simulated in production. |
| `COMMUNITY_MEDIA_DIR` | Private, writable, persistent directory; not a public static folder. |
| `COMMUNITY_HOST`, `COMMUNITY_PORT` | Binding, default loopback and 3001. |
| `H00K_TRUST_PROXY`, `COMMUNITY_TRUST_PROXY` | Only the actual trusted proxy addresses/CIDRs. Preserve client-IP limits without trusting arbitrary Internet headers. |
| `COMMUNITY_EXCHANGE_EGRESS_ISOLATED` | Explicit enablement only after the egress/budget prerequisite. |
| `COMMUNITY_SYNC_ENABLED` | Opt-in periodic read-only synchronization; disabled by default. |
| `COMMUNITY_MODERATOR_IDS` | Operator-controlled list of native account UUIDs; not a profile field. |

`npm run community:migrate` applies the idempotent schema, including additive account-lifecycle columns/tables. Back up and apply it before running this revision against a staging database; it does not run automatically on startup. `npm run community` starts the independent service. `npm run dev` starts the established market/frontend server. `compose.community.yaml` is an optional deployment on separately reserved resources, not an automatic modification of the production stack. In that compose file, provide both `COMMUNITY_DB_PASSWORD` and a matching `COMMUNITY_DATABASE_URL` pointing at `postgres:5432/h00k_community`. Prepare writable volume ownership for the non-root node user before running the service.

## First connector and truth labels

The initial connector supports the explicitly selected Bybit Global mainnet linear closed-PnL API. There is no order/transfer/withdrawal implementation or arbitrary host/path input. `readOnly` must be exactly 1; the account identity is checked before storing a secret and during synchronization. EU keys, other exchanges/account types and testnet are not silently retried against alternative hosts.

Import starts at the beginning of the current UTC month minus one day, with seven-day query windows, cursors, a bounded pagination budget, overlap and idempotent exchange order IDs. Connection state exposes partial history and stale/error status. This does not mean the whole lifetime, wallet equity, all positions or every account belonging to a person has been verified.

Statistics explicitly measure **closed orders**, not reconstructed full position cycles or equity return. The sum covers the whole imported dataset; the visible list is paginated independently. `closedPnl` is not reduced by fees a second time. Source updates have controlled upserts; already recorded event times do not move to a new risk window just because a correction arrives later. Verify exact funding/fee and account-mode behavior on staging fixtures from the intended real account type before enabling public claims.

Risk rules use decimal sums of negative imported closed-order results in a declared settlement currency. Hourly means rolling 60 minutes; day and month follow the configured IANA zone. No invented USDT/USD conversion is made. Incomplete, stale or mixed-currency data is not labelled complete. A risk crossing creates a durable private inbox notification; repeat polling does not duplicate it. Notifications do not close positions, block a broker or guarantee instantaneous delivery during API outages.

Rankings are opt-in and explicitly sort current-month closed-order win rate, require minimum observations and fresh complete reported coverage, and hide capital/absolute PnL. They are not an account-return ranking or endorsement of a person's offers. Participation milestones are distinct from trading results.

## Existing Replay, strategies and social workflow

The existing Replay implementation stays in place. Its journal can save a private SIM report to Community. It cannot create `hc_trades` rows or a real-API badge. Strategy templates reuse the existing HookChart presets, with their data prerequisites stated; editable text/checklists do not magically become executable backtests.

Plans, strategies, lessons and test reports have audience controls and saved revisions. Chats require accepted friends for initial contact/invites, membership checks, bounded polling and idempotent client message IDs. Message delivery/read receipts, E2EE, synchronized blind Replay sessions and a general-purpose executable strategy builder are not claimed by this initial workspace.

Reports and operator-gated decisions are persisted with reasons/audit. Fresh-account/contact and upload limits reduce abuse but do not make scammer detection perfect. Hidden financial values must remain hidden in images and labels too. A verified trading record never means someone is safe to send money or secrets to.

## Release gates still requiring real environment work

- Export and verify the existing Firebase identities, profiles, archive, drawings and watchlists; create a deliberate old-ID → native-ID mapping and migrate market-side alert/Telegram/surveillance ownership. Do not link accounts merely by an unverified typed email.
- Provision PostgreSQL, private media persistence, SMTP, backup/restore, encryption-key management and exact trusted proxy settings.
- Exercise the implemented account export/deletion, MFA recovery, session revocation and cleanup workers on staging; finalize retention, backup erasure/replay, email delivery/retry and production abuse procedures before an open financial-data service launch.
- Exercise real PostgreSQL networking/pooling, email delivery and Bybit permissions/history on a staging account with a dedicated read-only key. Offline tests are not those checks.
- Run browser visual/mobile QA and joint market/Community load testing. The current managed preview relay was unavailable; do not call browser QA passed.
- Review the changed authentication and social/data-processing notices, and localize the new Community interface for the agreed launch languages.

No schema migration, user-data migration, main-branch merge or production deployment is performed by preparing this branch. Keep the PR draft until these gates are satisfied.


## Account lifecycle added in the second implementation pass

Community exports are streamed as JSONL.gz, with keyset pages of 50 rows and one bounded image at a time. A password/factor-authorized ticket is random, expires after ten minutes, works once and is bound to the current owner, session and export scope. A different session or HEAD request cannot consume it. Revoking the session stops subsequent Community export pages. The compatibility proxy now streams responses and forwards attachment headers rather than buffering the entire file.

The separate market export includes only the owner's alerts, history, surveillance and Telegram connection/delivery data. Global bot secrets and pending linking tokens are excluded. Neither export requests exchange history. The copy is paginated live data, not an atomic database backup; an ending `complete` record marks successful completion. Unavailable private sources remain unavailable to the exporter.

Deletion immediately revokes native sessions/tickets, erases stored connector credentials, trades, notes, archives, recovery codes and profile data, scrubs the author's content/versions and makes chart descendants unavailable. A minimal tombstone preserves referential integrity. Shared conversations transfer to their oldest admin/member; other authors' content remains theirs. A durable queue cleans image bytes and market-side files, links, pending Telegram deliveries and surveillance workers with retries. Already delivered external messages, downloaded copies and backup retention are separate boundaries. h00k cannot revoke a read-only API key at the exchange; the user must do that there.

Community mutations use a short owner row lock and acknowledge success after transaction commit. Network connector requests do not hold that transaction: their writes recheck the live owner under a short lock. Upload metadata, risk notifications and background trade imports likewise cannot recreate a deleted owner's data. Nested PostgreSQL transactions use savepoints on the existing connection rather than acquiring another pool connection.

Offline validation now covers account lifecycle and the streaming proxy in addition to the original chart/security suite. The full test count at this pass is 521. Browser/mobile QA, real PostgreSQL networking/pooling and operational cleanup on the deployed volumes still require staging.


## Read-only migration preflight

`npm run community:migration-plan -- <normalized-bundle.json> [--check-target]` validates explicit owner mappings, profiles and archives without importing or linking accounts. The target option executes SELECT only. Reports use input hashes, counts and index-based issue codes instead of personal values. Raw Firebase exports need a trusted normalization step first. See [identity-migration-preflight.md](identity-migration-preflight.md). This does not remove the migration release gate.
