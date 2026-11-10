import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../server/community/db";
import { testDatabase } from "./fixtures/community-db";
import { createTestSession } from "./fixtures/user-session";
import { installAccountRoutes } from "../server/community/account";

const cwd = process.cwd(),
  fixture = fs.mkdtempSync(path.join(cwd, ".test-market-account-data-"));
process.chdir(fixture);
const [
  lifecycle,
  alerts,
  telegram,
  links,
  deliveries,
  surveillance,
  deleted,
  auth,
] = await Promise.all([
  import("../server/accountLifecycle"),
  import("../server/alertService"),
  import("../server/userTelegram"),
  import("../server/telegramLinkService"),
  import("../server/telegramDelivery"),
  import("../server/surveillanceService"),
  import("../server/deletedAccounts"),
  import("../server/userAuth"),
]);
process.chdir(cwd);
const previous = {
  bot: process.env.TELEGRAM_BOT_TOKEN,
  publicKey: process.env.H00K_AUTH_PUBLIC_KEY,
  key: process.env.COMMUNITY_ENCRYPTION_KEY,
  origin: process.env.APP_ORIGIN,
};
const serviceSession = createTestSession();
process.env.H00K_AUTH_PUBLIC_KEY = serviceSession.env.H00K_AUTH_PUBLIC_KEY;
process.env.TELEGRAM_BOT_TOKEN = "999:account-fixture";
process.env.COMMUNITY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const engine = new PGlite(),
  db = testDatabase(engine),
  password = "market data export test password";
let server: any, base: string;
interface Actor {
  id: string;
  email: string;
  cookie: string;
}
async function call(url: string, a?: Actor, method = "GET", body?: any) {
  const res = await fetch(base + url, {
    method,
    headers: {
      "X-H00K-Request": "1",
      ...(a ? { Cookie: a.cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { res, data: await res.json() };
}
async function register() {
  const email = randomUUID() + "@example.test",
    r = await call("/api/account/register", undefined, "POST", {
      email,
      password,
    });
  assert.equal(r.res.status, 201);
  return {
    id: r.data.user.uid,
    email,
    cookie: r.res.headers.getSetCookie()[0].split(";")[0],
  };
}
function seed(a: Actor, chat: string) {
  telegram.connectUserTelegram(a.id, "999", chat);
  alerts.createAlert({
    userId: a.id,
    symbol: "BTCUSDT",
    exchange: "binance",
    marketType: "futures",
    targetPrice: 110,
    condition: "gte",
    note: "private-" + a.id,
  });
  deliveries.recordSentTelegramMessage(a.id, "delivery-" + a.id, [1]);
  surveillance.saveSurveillanceList(a.id, [
    {
      id: randomUUID(),
      userId: a.id,
      symbol: "BTCUSDT",
      isActive: false,
      config: {},
    } as any,
  ]);
}
test.before(async () => {
  await migrate(db);
});
test.beforeEach(async () => {
  const app = express();
  app.use(express.json());
  installAccountRoutes(
    app,
    () => db,
    async () => {},
  );
  lifecycle.installAccountLifecycle(app, () => db);
  app.get(
    "/api/protected-service",
    auth.createUserAuth(() => db),
    (_req, res) => res.json({ success: true, owner: res.locals.userId }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  process.env.APP_ORIGIN = base;
});
test.afterEach(async () => {
  await new Promise<void>((resolve) => server.close(resolve));
});
test.after(async () => {
  await engine.close();
  fs.rmSync(fixture, { recursive: true, force: true });
  for (const [k, v] of Object.entries({
    TELEGRAM_BOT_TOKEN: previous.bot,
    H00K_AUTH_PUBLIC_KEY: previous.publicKey,
    COMMUNITY_ENCRYPTION_KEY: previous.key,
    APP_ORIGIN: previous.origin,
  }))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

test("market export contains only the owner and excludes global bot credentials", async () => {
  const a = await register(),
    b = await register();
  seed(a, "71001");
  seed(b, "71002");
  const ticket = await call("/api/account/export", a, "POST", {
    password,
    scope: "market",
  });
  assert.equal(ticket.res.status, 200);
  assert.equal(
    (await fetch(base + ticket.data.url, { headers: { Cookie: b.cookie } }))
      .status,
    404,
  );
  const response = await fetch(base + ticket.data.url, {
    headers: { Cookie: a.cookie },
  });
  assert.equal(response.status, 200);
  const text = gunzipSync(Buffer.from(await response.arrayBuffer())).toString();
  const rows = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(text.includes("private-" + a.id));
  assert.ok(!text.includes("private-" + b.id));
  assert.ok(!text.includes("account-fixture"));
  assert.ok(!/"(?:botToken|codeHash)":/.test(text));
  assert.equal(rows.at(-1).section, "complete");
  assert.ok(rows.some((row) => row.section === "telegram_delivery"));
  assert.equal(
    (await fetch(base + ticket.data.url, { headers: { Cookie: a.cookie } }))
      .status,
    404,
  );
});

test("durable cleanup retries incomplete work, preserves others and blocks stale account writes", async () => {
  const a = await register(),
    b = await register();
  seed(a, "72001");
  seed(b, "72002");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, options: any) =>
    String(input).includes("/getMe")
      ? Response.json({ ok: true, result: { username: "account_fixture_bot" } })
      : originalFetch(input, options)) as typeof fetch;
  try {
    assert.equal((await links.beginSharedTelegramLink(a.id)).success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    (
      await fetch(base + "/api/protected-service", {
        headers: serviceSession.headers(a.id),
      })
    ).status,
    200,
  );
  const result = await call("/api/account/delete", a, "POST", {
    password,
    confirm: "DELETE",
  });
  assert.equal(result.res.status, 200);
  assert.equal(
    (
      await fetch(base + "/api/protected-service", {
        headers: serviceSession.headers(a.id),
      })
    ).status,
    401,
    "native service tokens must stop before filesystem cleanup runs",
  );
  assert.equal(
    await lifecycle.cleanupMarketAccounts(db, (id) => {
      deleted.markAccountDeleted(id);
      throw new Error("interrupted disk write");
    }),
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT market_pending FROM hc_account_cleanup WHERE owner_id=$1",
        [a.id],
      )
    ).rows[0].market_pending,
    true,
  );
  assert.equal(
    await lifecycle.cleanupMarketAccounts(db),
    0,
    "leased failures must wait before retry",
  );
  await db.query(
    "UPDATE hc_account_cleanup SET lease_until=now()-interval '1 second' WHERE owner_id=$1",
    [a.id],
  );
  assert.equal(await lifecycle.cleanupMarketAccounts(db), 1);
  assert.equal(await lifecycle.cleanupMarketAccounts(db), 0);
  assert.equal(alerts.getAllAlerts(a.id).length, 0);
  assert.equal(alerts.getAllAlerts(b.id).length, 1);
  assert.equal(deliveries.exportTelegramDeliveries(a.id).length, 0);
  assert.equal(deliveries.exportTelegramDeliveries(b.id).length, 1);
  assert.equal(telegram.loadUserTelegram().has(a.id), false);
  assert.equal(surveillance.loadSurveillanceList(a.id).length, 0);
  assert.equal(surveillance.loadSurveillanceList(b.id).length, 1);
  assert.equal(links.getSharedTelegramStatus(a.id).linkPending, false);
  assert.throws(() =>
    alerts.createAlert({
      userId: a.id,
      symbol: "ETHUSDT",
      exchange: "bybit",
      marketType: "futures",
      condition: "gte",
      targetPrice: 10,
    }),
  );
  assert.throws(() => telegram.connectUserTelegram(a.id, "999", "73001"));
  assert.throws(() => surveillance.saveSurveillanceList(a.id, []));
  assert.equal(
    (await deliveries.sendUserTelegramMessage(a.id, "must not send")).success,
    false,
  );
  const marker = fs.readFileSync(
    path.join(fixture, "server/data/deleted_accounts.json"),
    "utf8",
  );
  assert.ok(!marker.includes(a.id));
  assert.equal(
    (
      await db.query(
        "SELECT market_pending,attempts FROM hc_account_cleanup WHERE owner_id=$1",
        [a.id],
      )
    ).rows[0].market_pending,
    false,
  );
});
