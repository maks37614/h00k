# HookChart: shared market delivery, diagnostics and Replay

## Live public Kline relay

Only live Screener, Fullscreen and Terminal HookChart clients use:
`wss://h00k.top/api/hookchart/klines?exchange=binance&market=futures&symbol=BTCUSDT&timeframe=1m`

Within **one running Node process**, all browser clients subscribed to an identical exchange/market/symbol/timeframe receive the same public exchange Kline stream. Server data is intentionally limited to OHLCV plus exchange event time and public buy volume/trade count. No credentials, private notes, open positions, indicators, alerts or user information are relayed.

- Defaults: **128 browser clients**, **48 active Kline scopes** per Node process.
- Configure `H00K_MAX_KLINE_CLIENTS` and `H00K_MAX_KLINE_MARKETS` in the VPS `.env`; do **not** raise limits before load testing.
- If the relay rejects a client, fails, or becomes unresponsive, the browser automatically uses the existing direct Binance/Bybit Kline stream. WebSocket-level backoff still applies.
- Kline relay endpoints are **read only**; large/slow client buffers are disconnected.
- Depth already has a separate shared relay `/api/hookchart/depth`; do **not** connect a second order-book upstream.
- All upstream subscriptions stop when the last browser subscriber leaves. No persistent history is created.
- The design shares streams in a single Node process. Multi-instance deployments need an external message bus, not a per-instance assumption of deduplication.

## Operator-only VPS metrics

Configure `H00K_OPS_TOKEN` in the VPS `.env` (minimum 32 bytes; keep secret). After restarting:

```bash
cd /home/ubuntu/h00k
read -rsp "Operator token: " H00K_TOKEN; echo
curl -fsS -H "Authorization: Bearer ${H00K_TOKEN}" \
  http://127.0.0.1:3000/api/ops/market-data \
  | python3 -m json.tool
unset H00K_TOKEN
```

Look for `hookChartKlineRelay.activeMarkets`, `.clients`, `.upstreamSockets`, `.reconnects`, `.slowConsumers`, `.rejected`, and `.failures`. Existing private operator fields report CPU (one-core normalized), event-loop delay, memory, exchange HTTP budgets, market ticker errors and other feed health.

**No operator token = 404**, not a public performance dashboard.

## Optional browser diagnostics

Open an **actual live HookChart** with `?hookchartPerf=1` in the URL and reload. A small local panel reports browser animation FPS (not trading tick rate), Canvas scene paints and average paint time, Kline arrival lag, relay/direct transport counts, reconnects and WebSocket errors. JS heap uses Chromium's optional `performance.memory`; Firefox/iOS Safari may display `н/д`.

This diagnostic adds a single rAF sampler **only when explicitly enabled**. It does not upload metrics, inspect trades/accounts or write to storage. Remove the query parameter and reload to disable it. Browser diagnostics alone cannot report VPS CPU: use the private endpoint.

## Controlled capacity test

Run only on your own VPS and **begin small** (beware existing live users):

```bash
docker compose exec -T app node scripts/benchmark-ws.mjs \
  --url 'ws://127.0.0.1:3000/api/hookchart/klines?exchange=binance&market=futures&symbol=BTCUSDT&timeframe=1m' \
  --clients 10 --seconds 20 --ramp 2

docker compose exec -T app node scripts/benchmark-http.mjs \
  --users 20 --seconds 30

docker stats --no-stream
```

Increase the load gradually only if CPU, RSS, event-loop lag, latency and `rejected/slowConsumers` remain acceptable. Sockets created by the benchmark point **only to your own read-only server endpoint**, never place orders. The Kline benchmark checks connection capacity, not full-browser Canvas FPS.

## Historical Replay stays isolated

The historical `ReplayChart` does **not** subscribe to the Kline relay, market trades, depth, liquidations or funding. Its own data controls candle time and causality.

- Forward stepping reuses the unchanged prefix and appends one historical candle.
- Rewind, new date or a modified older candle triggers a **full** history reset.
- The fallback LightweightCharts renderer updates both price and volume incrementally.
- No live liquidation/market-print/DOM visual controls are added to Replay.
