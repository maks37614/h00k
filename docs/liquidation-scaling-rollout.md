# Liq scaling and historical heatmap rollout (staged)

## What was changed

1. **Exchange upstream:** `LIQ_MULTIPLEX_ENABLED=1` (default) uses one Binance/Bybit public
   WebSocket for up to 64 subscribed symbols per exchange shard, instead of one
   exchange WebSocket per symbol. When 256 markets are viewed (128 Binance,
   128 Bybit), four upstream sockets suffice in the **unit-test model**.
2. **Demand-based markets:** `LIQ_MARKET_CAP=256` (configurable 64–768);
   an idle historical cache is evicted before rejecting a new viewed market.
   Two minutes after the last viewer, its exchange stream is released; the
   existing 30-minute chart event cache stays available, subject to expiry.
3. **Browser fanout:** the existing chart protocol `/api/hookchart/liquidations`
   stays unchanged. An alternative `/api/hookchart/liquidations-multi` can
   carry up to 64 `exchange:symbol` scopes on one site WebSocket.
   Browser use is opt-in via `VITE_LIQ_CLIENT_MULTIPLEX=1` at **build time**.
4. **Live chart semantics:** existing Long/Short, Liq 5m cascade, adaptive
   thresholds, session totals, and depth/density processing are untouched.
   Recent snapshots still retain at most 30 minutes or 1,500 events per market.
   No synthetic liquidation events are generated.
5. **Optional PostgreSQL raw event archive:** `LIQ_ARCHIVE_ENABLED=1` starts a
   bounded, asynchronous writer using the unique
   `(exchange,symbol,event_id)` key. Duplicate packets cannot inflate totals;
   cumulative Binance order updates can increase, not decrease, the notional.
   Database migrations are created on first write. The observed-only API
   `GET /api/hookchart/liquidation-heatmap?exchange=binance&symbol=BTCUSDT&period=24h`
   (or `period=7d`) is available only with the archive enabled.
   The chart-facing map overlay itself is a separate future UI step.

## Important limitations

- No system can reconstruct liquidations from before collection, server
  downtime, or instruments with no active viewers. Public Binance forceOrder
  reports only a subset during 1000 ms intervals; the Bybit price is a
  bankruptcy price. The archive is **observed events**, never complete
  exchange-wide liquidation volume or a predicted liquidation map.
- The default limit is now 256 simultaneous `exchange:symbol` markets,
  **not all listings simultaneously**. Do not blindly raise to 768 on
  a 2-vCPU/4-GB VPS without measuring upstream stability, memory, and FD caps.
- The 2,000 simultaneous **browser-side Liq connections** limit remains until
  performance tests. Optional multi-market browser routing can reduce the
  number of browser WebSockets for Terminal charts.
- Do not enable archiving until the PostgreSQL instance has disk headroom,
  backups, measured write latency and a configured monitoring alert.
  A bounded queue can drop events when PostgreSQL is unavailable; the
  protected operator metrics report `droppedOnOverflow` and failures.
- Inactive markets are not collected continuously. A complete 7-day heatmap
  for every listed contract requires separate collection capacity planning.
- This feature adds **no chart drawing, polling, or browser WS overhead when
  the heatmap UI is off**. The existing Liq feed continues to operate as
  before whenever a futures chart is open.

## Safe deployment on the Ubuntu/Docker VPS

```bash
cd /home/ubuntu/h00k
git status --short
git fetch origin
git pull --ff-only origin main
# Check that /home/ubuntu/h00k/.env has the existing secrets intact.
# Optional flags; they use safe defaults if absent:
# LIQ_MULTIPLEX_ENABLED=1
# LIQ_MARKET_CAP=256
# LIQ_CLIENT_CAP=2000
# VITE_LIQ_CLIENT_MULTIPLEX=0
# LIQ_ARCHIVE_ENABLED=0
docker compose config --quiet
docker compose up -d --build --no-deps app
docker compose ps
docker compose logs --tail 120 app
```

## Validation

1. Open Binance Futures BTCUSDT, Bybit Futures BTCUSDT and another
   coin; verify Liq Long/Short and their individual totals still work.
2. Open the same symbol in multiple Terminal charts and verify each receives
   the shared data without duplicated Liq values.
3. Use the existing protected operator endpoint
   `GET /api/ops/market-data` with the locally configured
   `H00K_OPS_TOKEN` to inspect `liquidationFeed.upstreamPool.shards`,
   `upstreamSockets`, `subscribedTopics`, `rejectedClients`,
   `liquidationArchive.queued`, `failures` and
   `droppedOnOverflow`. Never share this token in chat.
4. Rollback **upstream pooling only**: set `LIQ_MULTIPLEX_ENABLED=0` in
   `.env` and rebuild/restart app. This restores the legacy 64-market
   safety cap without reverting any HookChart visual code.
5. Browser multiplex after full VPS validation: set
   `VITE_LIQ_CLIENT_MULTIPLEX=1` in `.env` and rebuild app;
   set to `0` and rebuild to revert.
6. Before enabling Postgres archive, back up `h00k_users`:
   ```bash
   mkdir -p /home/ubuntu/h00k-backups
   docker compose exec -T postgres pg_dump -U h00k -d h00k_users -Fc \
     > /home/ubuntu/h00k-backups/pre-liq-archive.dump
   ```
   Then set `LIQ_ARCHIVE_ENABLED=1` and restart; monitor file usage,
   write failures and the bounded pending queue over an initial pilot.
   Restore to `0` if postgres, CPU, disk or query latency regress.
   Archive tables are **not automatically deleted** by disabling the flag.

## Test strategy

- `tests/liquidation-upstream-pool.test.ts` ensures 256 market scopes need
  four upstream sockets in the test harness, ACK isolation and cleanup.
- `tests/liquidation-feed.test.ts`, `tests/liquidation-multi-client-relay.test.ts`,
  `tests/liquidation-browser-multiplex.test.ts` verify old/new protocols.
- `tests/liquidation-archive.test.ts` validates idempotent upserts,
  bounded queue, migration constraints and observed-only data.
- Existing HookChart Liq rendering and subscription tests run in
  `.github/workflows/liquidation-scaling.yml`.
- Offline CI tests are not a substitute for actual exchange WebSocket and
  VPS load testing.
