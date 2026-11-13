# h00k.top — clean PostgreSQL-only registration

## Scope

The owner explicitly chose a **fresh start without migrating existing accounts**.
No old login, user profile or archive is imported. Existing account holders must
register anew with email + password and confirm the email address.

The site continues to expose screener, terminal, chart, replay, formations,
exchange WebSocket data, alerts, Telegram and surveillance routes. Personal
features are available to **newly registered, verified PostgreSQL users**.
The old authentication provider, browser SDK, obsolete access-code flow and
cloud database rules have been removed from this branch.

**The PostgreSQL-only source is on `main`, but this does not prove the VPS has been updated.**
Test on staging first, including real SMTP delivery, actual registration and
protected personal features. Do not replace production until acceptance checks pass.

## Environment variables

For Docker Compose, configure a private .env file (never commit this file):

```dotenv
POSTGRES_PASSWORD=GENERATE_WITH_openssl_rand_hex_32
PUBLIC_BASE_URL=https://h00k.top
AUTH_TRUST_PROXY=1
SMTP_HOST=smtp.mail.ovh.net
SMTP_PORT=465
SMTP_USER=info@h00k.top
SMTP_PASSWORD=YOUR_SMTP_PASSWORD
SMTP_FROM="h00k <info@h00k.top>"
```

The SMTP example above applies to the owner's OVHcloud MX Plan mailbox; use its
**mailbox password**, never the OVH admin-account password. Verify SPF/DKIM and
real inbox delivery on the VPS. Do not commit `.env` to GitHub.

SMTP TLS is mandatory. Verification links last 24 hours; password reset
links last 30 minutes. Without working SMTP, registration fails closed.

The Compose database is private (no published 5432 port), stores users and
account settings in a persistent volume, and has 0.5 CPU / 512 MiB limits.
The Node auth connection pool is capped at 4 clients. Password hashing
concurrency is capped at 2 jobs so excessive logins cannot monopolize the VPS.

## Existing file-backed personal alerts

Existing `server/data` files and the Docker volume `h00k_app_data`
may contain alerts and 24/7 monitors belonging to **former user IDs**.
New PostgreSQL registrations get new user IDs. Orphan personal alert workers
can still run independently if old server files are reused; they may continue
sending notifications and wasting resources.

Before switching production:
1. Make an encrypted backup of `h00k_app_data`, the current source revision,
   current proxy configuration and all persistent user/surveillance files.
2. In staging, identify which data files represent **personal alerts,
   Telegram pairings, surveillance and history**, versus shared market caches.
3. Archive and reset **only former-user personal state**, preserving shared
   market data and caches. Explicitly verify old monitors stop.
4. Never use `docker compose down -v` or delete the whole `h00k_app_data`
   volume during rollback; this would also remove unrelated application data.
5. Start fresh registrations and verify new per-user alerts, Telegram linking,
   surveillance and archive storage.

The cleanup of old personal server files is an **operator staging action**
and is not performed automatically by this branch.

## Test and deploy on staging

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/auth/config
```

Run GitHub Actions and follow up with real browser smoke tests on desktop
and mobile: register, receive/verify email, login, remember login, revoke
sessions, password reset, edit profile, synchronize watchlist and HookChart
settings, create/rearm/delete alerts, Telegram connect/test, start/stop
24/7 surveillance, save/delete archived formations, screener, terminal,
fullscreen chart, early W/M, replay and both exchange WebSocket streams.

## Backup the new PostgreSQL database

```bash
docker compose exec -T postgres pg_dump -U h00k -Fc h00k_users > h00k-users-$(date +%F).dump
```

Keep an encrypted and tested copy outside the VPS. PostgreSQL dumps do not
include `h00k_app_data`; back it up separately.

## Shared h00k Community account (future)

Community should use a dedicated authorization-code integration against
the shared identity service, with separate roles and scopes. Do not reuse
a parent-domain authentication cookie on wildcard user subdomains.
**Community single-sign-on is not yet implemented by this change.**
