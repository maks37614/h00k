# h00k.top — PostgreSQL authentication rollout (staging first)

## Status and safety boundary

This branch is NOT a production-ready Firebase cutover until the migration and
email verification tests below are complete. Do NOT merge or run the new Compose
stack on the production h00k VPS just because CI builds successfully.

The market-screener, terminal, replay and exchange WebSocket routes remain
independent of account PostgreSQL. Existing server-side 24/7 alerts, Telegram
linking and surveillance continue to use their own durable files and workers;
preserving the existing \`h00k_app_data\` volume and user IDs is mandatory.

## Configuration (keep private)

1. Back up the entire VPS deployment, including \`h00k_app_data\`, current
   source revision, Firestore exports and account data.
2. Create a staging DNS name and use a staging SMTP sender.
3. In an uncommitted \`.env\`, configure:
   - \`POSTGRES_PASSWORD\`: \`openssl rand -hex 32\`
   - \`PUBLIC_BASE_URL=https://STAGING_DOMAIN\`
   - \`SMTP_HOST\`, \`SMTP_PORT\`, \`SMTP_USER\`, \`SMTP_PASSWORD\`, \`SMTP_FROM\`
   - \`AUTH_TRUST_PROXY=1\` only when precisely one trusted reverse proxy
     forwards to the loopback-only app.
4. The Compose PostgreSQL service has **no published port**, a dedicated
   persistent volume, maximum 30 connections, 64MB shared buffers, 512MiB
   container RAM and 0.5 CPU. The auth Node pool is max 4 connections.
5. Never commit \`.env\`, Firebase export files, session cookies or SMTP secrets.

Run on the STAGING deployment only:

    docker compose config --quiet
    docker compose up -d --build
    docker compose ps
    curl -fsS http://127.0.0.1:3000/api/health
    curl -fsS http://127.0.0.1:3000/api/auth/config

Do not expose PostgreSQL port 5432 or the Node port 3000 publicly.

## Existing account migration

The new identity table uses TEXT user IDs specifically to retain Firebase UIDs.
Any account that changes UID would lose access to existing file-backed
alerts/surveillance/favorites, so changing UID is prohibited.

Export using an authorized Firebase Admin client and normalize to:

    {
      "users": [
        {
          "uid": "firebase-uid",
          "email": "user@example.com",
          "emailVerified": true,
          "displayName": "Trader",
          "profile": {"defaultExchange": "binance", "watchlist": []},
          "archive": [{"id": "arch_example", "userId": "firebase-uid", "...": "..."}]
        }
      ]
    }

The importer runs in dry-run mode unless explicitly given \`--apply\`:

    docker cp /secure/firebase-normalized.json CONTAINER_NAME:/tmp/firebase-normalized.json
    docker compose exec app node --import tsx scripts/import-firebase-users.ts --file /tmp/firebase-normalized.json
    docker compose exec app node --import tsx scripts/import-firebase-users.ts --file /tmp/firebase-normalized.json --apply

Importing creates password hashes that nobody knows; all existing users need a
secure password-reset link. Never transfer raw Firebase passwords or publish
password hashes. Importer intentionally does NOT delete or overwrite active
PostgreSQL user accounts. Immediately remove the export from the container,
host and backups once the migration has been validated under your retention policy.

**Not yet automated:** extracting Firebase Auth and Firestore data; migrating
Firestore-only alert history and alert documents; reconciling archive
per-user counts and user-linked caches. Existing \`server/data/alerts.json\`,
\`alert_history.json\`, surveillance and Telegram files remain on the
\`h00k_app_data\` volume and are not moved by the importer. Missing Cloud
history must be migrated separately before Firebase is shut off.

## Mandatory acceptance tests

- Register a new address, verify via actual email, sign in/out, remember-login
  across browser restart, revoke another session and logout-all.
- Test invalid/expired/reused verification and password-reset links.
- Ensure no cross-account archive, watchlist, alerts, Telegram or surveillance.
- Compare pre/post-export counts and UID mapping for every migrated user.
- Confirm triggered alerts remain triggered and cannot be re-armed by stale UI.
- Test HookChart, terminal, full-screen charts, formations, early W/M, replay,
  liquidation metrics and Binance/Bybit WebSockets without changes.
- Check CPU, RAM, session query duration, active connections and auth rate-limit
  activity on 2CPU/4GiB VPS during a staged login/load test.
- Verify restore from PostgreSQL and app_data backup before production switch.

## Backups

Use an encrypted and access-restricted PostgreSQL dump on a filesystem with
sufficient free space. One possible manual command:

    docker compose exec -T postgres pg_dump -U h00k -Fc h00k_users > h00k-users-$(date +%F).dump

Back up \`h00k_app_data\` separately (it contains market alerts and surveillance
records). Never use \`docker compose down -v\` during migration or rollback.

## h00k Community

The future Community should authenticate through a dedicated, short-lived,
single-use authorization-code exchange with the same central h00k identity
provider, using separate client IDs/scopes and server-side session cookies.
Do not copy the main-site cookie to wildcard \`*.h00k.top\`, and do not allow
Community to read the private account database directly. The shared SSO
protocol itself is a **separate integration step**, not implemented here.
