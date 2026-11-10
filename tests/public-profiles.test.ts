import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import * as OTPAuth from "otpauth";
import { migrate } from "../server/community/db";
import { installAccountRoutes } from "../server/community/account";
import { installCommunityRoutes } from "../server/community/routes";
import { installPublicProfiles } from "../server/community/publicProfiles";
import { nameFromHost, profileName, NAME_CHANGE_INTERVAL } from "../server/community/profileNames";
import { testDatabase } from "./fixtures/community-db";
import { captureChartDocument } from "../src/community/chartDocument";
import { createItem, policy, saveChart } from "../server/community/content";

const engine = new PGlite(), db = testDatabase(engine), password = "correct horse profile password";
const saved = { ...process.env };
let server: any, base: string, directory: string, now = Date.now(), requests = 0;
type Actor = { id: string; cookie: string };
async function call(url: string, actor?: Actor, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const requestHeaders = {
    "X-H00K-Request": "1", "X-Forwarded-For": "192.0.2." + (++requests % 250 + 1),
    ...(actor ? { Cookie: actor.cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers,
  };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // Node fetch normalizes Host. Use actual HTTP headers for virtual-host boundary tests.
  const res = headers.Host ? await new Promise<Response>((resolve, reject) => {
    const req = request(base + url, { method, headers: requestHeaders }, incoming => {
      const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(chunk));
      incoming.on("end", () => {
        const responseHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
      });
    });
    req.on("error", reject); req.end(payload);
  }) : await fetch(base + url, { method, headers: requestHeaders, ...(payload === undefined ? {} : { body: payload }) });
  const text = await res.text(); let data: any;
  try { data = JSON.parse(text); } catch { data = null; }
  return { res, data, text };
}
async function actor(verified = true): Promise<Actor> {
  const result = await call("/api/account/register", undefined, "POST", { email: randomUUID() + "@example.test", password, displayName: "Trader" });
  assert.equal(result.res.status, 201, result.text);
  const a = { id: result.data.user.uid, cookie: result.res.headers.getSetCookie()[0].split(";")[0] };
  if (verified) await db.query("UPDATE hc_users SET email_verified=true WHERE id=$1", [a.id]);
  return a;
}
async function claim(a: Actor, username: string) {
  return call("/api/account/username", a, "POST", { username, password });
}
async function enable(a: Actor, community: any = {}) {
  const result = await call("/api/account/profile", a, "PATCH", { community: { publicProfileEnabled: true, ...community } });
  assert.equal(result.res.status, 200, result.text);
}
async function named(name: string) { const a = await actor(); assert.equal((await claim(a, name)).res.status, 200); await enable(a); return a; }
async function post(a: Actor, body: any, audience = "public", chartId?: string) {
  const rules = await policy(db, a.id);
  return createItem(db, rules, { kind: "post", audience, body, ...(chartId ? { chartId } : {}) });
}
function snapshot() {
  const start = Math.floor(Date.now() / 60000) * 60 - 3600;
  return captureChartDocument({ symbol: "BTCUSDT", exchange: "binance", marketType: "futures", timeframe: "1m",
    candles: Array.from({ length: 50 }, (_, i) => ({ time: start + i * 60, open: 100, high: 110, low: 90, close: 102, volume: 20 })),
    markers: [{ id: "entry", type: "entry", label: "Entry", price: 100, color: "#38bdf8" }], drawings: [] });
}
test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "h00k-public-profiles-"));
  process.env.COMMUNITY_PROFILE_DOMAIN = "h00k.test";
  process.env.COMMUNITY_STANDALONE_ENABLED = "1";
  process.env.COMMUNITY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.COMMUNITY_MEDIA_DIR = directory;
  await fs.writeFile(path.join(directory, "profile.html"), "<!doctype html><div id='profile-root'>public entry</div>");
  await fs.writeFile(path.join(directory, "community.html"), "<!doctype html><div id='community-root'>community entry</div>");
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "assets", "fixture-123456.js"), "/* public build asset */");
  await migrate(db);
  const app = express(); app.set("trust proxy", "loopback");
  installPublicProfiles(app, () => db, directory);
  app.use(express.json());
  installAccountRoutes(app, () => db, async () => {}, () => now);
  installCommunityRoutes(app, () => db);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port; process.env.APP_ORIGIN = base;
});
test.after(async () => {
  if (server) await new Promise<void>(resolve => server.close(resolve));
  await engine.close(); await fs.rm(directory, { recursive: true, force: true });
  for (const key of ["APP_ORIGIN", "COMMUNITY_PROFILE_DOMAIN", "COMMUNITY_STANDALONE_ENABLED", "COMMUNITY_ENCRYPTION_KEY", "COMMUNITY_MEDIA_DIR"])
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
});

test("profile names normalize case, reject reserved/service/Unicode labels and nested or forged hosts", () => {
  assert.equal(profileName(" IvAn "), "ivan");
  for (const name of ["admin", "support", "admin-team", "support-123", "official1", "api", "mail", "www", "community-stage", "xn--alice", "h00k-owner", "іvan", "alice.", "ab", "-ivan", "ivan-"])
    assert.throws(() => profileName(name));
  assert.equal(nameFromHost("IVAN.h00k.test:443"), "ivan");
  for (const host of ["ivan.h00k.test.evil.test", "ivan.evil.h00k.test", "ivan.h00k.test@evil.test", "ivan.h00k.test,evil.test", "admin.h00k.test"])
    assert.equal(nameFromHost(host), null);
});

test("claim requires verified email, fresh credentials and cannot be forged through profile JSON", async () => {
  const a = await actor(false);
  assert.equal((await claim(a, "credential-test")).res.status, 403);
  await db.query("UPDATE hc_users SET email_verified=true WHERE id=$1", [a.id]);
  assert.equal((await call("/api/account/username", a, "POST", { username: "credential-test", password: "wrong" })).res.status, 401);
  assert.equal((await claim(a, "credential-test")).res.status, 200);
  await call("/api/account/profile", a, "PATCH", { username: "forged-name", community: { username: "forged-name" } });
  assert.equal((await call("/api/account/username", a)).data.username, "credential-test");
  assert.equal((await call("/api/public/profiles/credential-test")).res.status, 404);
  assert.equal((await call("/api/account/profile", a, "PATCH", { community: { publicProfileEnabled: "true" } })).res.status, 400);
});

test("two users cannot claim the same case-insensitive name", async () => {
  const a = await actor(), b = await actor();
  const results = await Promise.all([claim(a, "shared-name"), claim(b, "SHARED-NAME")]);
  assert.deepEqual(results.map(r => r.res.status).sort(), [200, 409]);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM hc_profile_names WHERE username='shared-name'")).rows[0].n, 1);
});

test("claim consumes the configured second factor atomically and rejects replay", async () => {
  const a = await actor();
  const setup = await call("/api/account/mfa/setup", a, "POST", { password });
  assert.equal(setup.res.status, 200, setup.text);
  const totp = new OTPAuth.TOTP({ secret: setup.data.secret });
  const previous = now; now += 30_000;
  assert.equal((await call("/api/account/mfa/confirm", a, "POST", { code: totp.generate({ timestamp: now }) })).res.status, 200);
  assert.equal((await claim(a, "mfa-person")).res.status, 401);
  now += 30_000;
  const code = totp.generate({ timestamp: now });
  assert.equal((await call("/api/account/username", a, "POST", { username: "mfa-person", password, code })).res.status, 200);
  assert.equal((await call("/api/account/username", a, "POST", { username: "mfa-person", password, code })).res.status, 401);
  now = previous;
});

test("rename observes cooldown; retired addresses cannot be reassigned and failed claims preserve the current name", async () => {
  const a = await named("old-address"), b = await named("occupied-address");
  assert.equal((await claim(a, "new-address")).res.status, 409);
  const previous = now; now += NAME_CHANGE_INTERVAL + 1;
  assert.equal((await claim(a, "occupied-address")).res.status, 409);
  assert.equal((await call("/api/account/username", a)).data.username, "old-address");
  assert.equal((await claim(a, "new-address")).res.status, 200);
  assert.equal((await call("/api/public/profiles/old-address")).res.status, 404);
  const c = await actor(); assert.equal((await claim(c, "old-address")).res.status, 409);
  const retired = (await db.query("SELECT username,owner_id FROM hc_profile_names WHERE retired_at IS NOT NULL")).rows;
  assert.ok(retired.some(row => row.username === null && row.owner_id === null));
  now = previous;
});

test("anonymous profile is a whitelist and independent opt-in; partial privacy updates preserve settings", async () => {
  const a = await named("privacy-person");
  await call("/api/account/profile", a, "PATCH", { balance: "PRIVATE_BALANCE", secret: "PRIVATE_SECRET", community: {
    bio: "private biography", bioAudience: "private", interests: "friends interests", interestsAudience: "friends",
    lifestyle: "public routine", lifestyleAudience: "public", telegram: "https://t.me/private_channel", telegramAudience: "private",
    status: { text: "private mood", audience: "private" },
  } });
  const result = await call("/api/public/profiles/privacy-person");
  assert.equal(result.res.status, 200); assert.equal(result.data.profile.lifestyle, "public routine");
  assert.equal(result.data.profile.bio, ""); assert.equal(result.data.profile.interests, ""); assert.equal(result.data.profile.telegram, "");
  assert.equal(result.data.profile.status, ""); assert.equal(result.data.profile.statistics, null);
  assert.doesNotMatch(result.text, /PRIVATE_|private biography|friends interests|private_channel|@example.test|password_hash|mfa_secret/);
  assert.equal(result.res.headers.get("cache-control"), "private, no-store"); assert.equal(result.res.headers.getSetCookie().length, 0);
  assert.equal((await call("/api/account/me", a)).data.profile.community.publicProfileEnabled, true);
  await enable(a, { publicProfileEnabled: false });
  assert.equal((await call("/api/public/profiles/privacy-person")).res.status, 404);
});

test("public wall excludes private/friends material and does not serialize arbitrary body fields", async () => {
  const a = await named("wall-owner");
  const visible = await post(a, { text: "public text", unknownPrivateField: "DO_NOT_SERIALIZE" });
  await post(a, { text: "friends post" }, "friends"); await post(a, { text: "private post" }, "private");
  const result = await call("/api/public/profiles/wall-owner/posts");
  assert.deepEqual(result.data.items.map((i: any) => i.id), [visible]);
  assert.doesNotMatch(result.text, /DO_NOT_SERIALIZE|friends post|private post|owner_id|revision/);
});

test("saved public chart is fetched only explicitly and revocation closes direct chart links", async () => {
  const a = await named("chart-owner"), document = snapshot();
  const id = await saveChart(db, await policy(db, a.id), document), item = await post(a, { text: "saved setup" }, "public", id);
  const wall = await call("/api/public/profiles/chart-owner/posts");
  assert.equal(wall.data.items[0].chart.symbol, "BTCUSDT");
  const full = await call(`/api/public/profiles/chart-owner/posts/${item}/chart`);
  assert.equal(full.res.status, 200); assert.equal(full.data.document.markers[0].price, 100);
  full.data.document.markers[0].price = 900;
  assert.equal((await call(`/api/public/profiles/chart-owner/posts/${item}/chart`)).data.document.markers[0].price, 100);
  await db.query("UPDATE hc_items SET audience='friends' WHERE id=$1", [item]);
  assert.equal((await call(`/api/public/profiles/chart-owner/posts/${item}/chart`)).res.status, 404);
  assert.equal((await call("/api/public/profiles/chart-owner/posts")).data.items.length, 0);
});

test("private source charts and disabled source owners cannot be exposed by public descendants", async () => {
  const source = await named("source-person"), reply = await named("reply-person"), document = snapshot();
  const parent = await saveChart(db, await policy(db, source.id), document);
  const parentPost = await post(source, { text: "original" }, "public", parent);
  const fork = await saveChart(db, await policy(db, reply.id), document, parent);
  const replyPost = await post(reply, { text: "alternative" }, "public", fork);
  await post(reply, { text: "repost commentary", sourceItemId: parentPost });
  assert.equal((await call(`/api/public/profiles/reply-person/posts/${replyPost}/chart`)).res.status, 200);
  await db.query("UPDATE hc_items SET audience='private' WHERE id=$1", [parentPost]);
  assert.equal((await call(`/api/public/profiles/reply-person/posts/${replyPost}/chart`)).res.status, 404);
  assert.equal((await call("/api/public/profiles/reply-person/posts")).data.items.length, 0);
  await db.query("UPDATE hc_items SET audience='public' WHERE id=$1", [parentPost]);
  await enable(source, { publicProfileEnabled: false });
  assert.equal((await call(`/api/public/profiles/reply-person/posts/${replyPost}/chart`)).res.status, 404);
});

test("public photos require both a visible post and its owner's media, checked on every read", async () => {
  const a = await named("photo-person"), media = randomUUID(), unlinked = randomUUID();
  await db.query("INSERT INTO hc_media(id,owner_id,bytes) VALUES($1,$3,4),($2,$3,4)", [media, unlinked, a.id]);
  await fs.writeFile(path.join(directory, media + ".webp"), Buffer.from("RIFF"));
  const item = await post(a, { text: "photo", photos: [media] });
  const url = `/api/public/profiles/photo-person/posts/${item}/media/`;
  assert.equal((await call(url + media)).res.status, 200);
  assert.equal((await call(url + unlinked)).res.status, 404);
  await db.query("UPDATE hc_items SET audience='private' WHERE id=$1", [item]);
  assert.equal((await call(url + media)).res.status, 404);
});

test("statistics and amounts have independent opt-ins, with no trade rows, notes or account credentials", async () => {
  const a = await named("stats-person"), connection = randomUUID();
  await db.query("INSERT INTO hc_connections(id,owner_id,exchange,account_hash,credential) VALUES($1,$2,'bybit',$3,'SECRET_CREDENTIAL')", [connection, a.id, randomUUID()]);
  for (const [i, pnl] of [10, 20, -5, 0].entries()) await db.query(
    "INSERT INTO hc_trades(connection_id,source_id,owner_id,symbol,currency,pnl,closed_at,source) VALUES($1,$2,$3,'BTCUSDT','USDT',$4,now(),$5)",
    [connection, "order-" + i, a.id, pnl, { privateAccount: "PRIVATE_ACCOUNT" }],
  );
  assert.equal((await call("/api/public/profiles/stats-person")).data.profile.statistics, null);
  await enable(a, { statisticsAudience: "public", amountsAudience: "private", tradesAudience: "public", notesAudience: "public" });
  const response = await call("/api/public/profiles/stats-person");
  const total = response.data.profile.statistics.totals[0];
  assert.equal(total.count, 4); assert.equal(total.winRate, 2 / 3 * 100); assert.equal(total.pnl, undefined);
  assert.doesNotMatch(response.text, /SECRET_CREDENTIAL|PRIVATE_ACCOUNT|order-|BTCUSDT|connection_id|notes|balance/);
  await enable(a, { amountsAudience: "public" });
  assert.match((await call("/api/public/profiles/stats-person")).data.profile.statistics.totals[0].pnl, /^25(?:\.0+)?$/);
});

test("personal hosts cannot mutate, use private APIs, impersonate another host or receive session cookies", async () => {
  const a = await named("host-person");
  assert.equal((await call("/", undefined, "GET", undefined, { Host: "host-person.h00k.test" })).res.status, 200);
  assert.equal((await call("/api/account/me", a, "GET", undefined, { Host: "host-person.h00k.test" })).res.status, 404);
  const mutation = await call("/api/account/logout", a, "POST", {}, { Host: "host-person.h00k.test" });
  assert.equal(mutation.res.status, 405); assert.equal(mutation.res.headers.getSetCookie().length, 0);
  assert.equal((await call("/api/account/me", a)).data.user.uid, a.id);
  assert.equal((await call("/api/public/profiles/chart-owner", undefined, "GET", undefined, { Host: "host-person.h00k.test" })).res.status, 404);
  const spoof = await call("/", undefined, "GET", undefined, { Host: "unknown-person.h00k.test", "X-Forwarded-Host": "host-person.h00k.test" });
  assert.equal(spoof.res.status, 404);
  assert.equal((await call("/", undefined, "GET", undefined, { Host: "admin.h00k.test" })).res.status, 404);
});

test("standalone workspace and fallback profile paths use independent entries", async () => {
  assert.match((await call("/")).text, /community-root/);
  assert.match((await call("/u/host-person")).text, /profile-root/);
  const root = await call("/", undefined, "GET", undefined, { Host: "host-person.h00k.test" });
  assert.match(root.text, /profile-root/); assert.doesNotMatch(root.text, /community-root/);
  assert.match(root.res.headers.get("content-security-policy")!, /connect-src 'self'/);
  assert.equal(root.res.headers.get("cache-control"), "private, no-store");
  const asset = await call("/profile-assets/assets/fixture-123456.js", undefined, "GET", undefined, { Host: "host-person.h00k.test" });
  assert.equal(asset.res.status, 200); assert.match(asset.res.headers.get("cache-control")!, /public.*immutable/);
});

test("public wall is bounded and paginated without exposing another owner's cursor", async () => {
  const a = await named("page-person");
  await db.query("INSERT INTO hc_items(id,owner_id,kind,audience,body,created_at) SELECT gen_random_uuid(),$1,'post','public',jsonb_build_object('text','entry '||n),now()+n*interval '1 second' FROM generate_series(1,17) n", [a.id]);
  const first = (await call("/api/public/profiles/page-person/posts")).data;
  assert.equal(first.items.length, 15); assert.ok(first.next);
  const second = (await call("/api/public/profiles/page-person/posts?before=" + first.next)).data;
  assert.equal(second.items.length, 2); assert.equal(second.next, null);
  assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 17);
  const foreign = (await db.query("SELECT id FROM hc_items WHERE owner_id<>$1 LIMIT 1", [a.id])).rows[0];
  assert.deepEqual((await call("/api/public/profiles/page-person/posts?before=" + foreign.id)).data.items, []);
});

test("deletion immediately hides the profile and retires its address without retaining an owner mapping", async () => {
  const a = await named("deleted-person");
  const result = await call("/api/account/delete", a, "POST", { password, confirm: "DELETE" });
  assert.equal(result.res.status, 200, result.text);
  assert.equal((await call("/api/public/profiles/deleted-person")).res.status, 404);
  assert.equal((await call("/u/deleted-person")).res.status, 404);
  const b = await actor(); assert.equal((await claim(b, "deleted-person")).res.status, 409);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM hc_profile_names WHERE owner_id=$1 OR username='deleted-person'", [a.id])).rows[0].n, 0);
});
