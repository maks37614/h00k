import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { PGlite } from "@electric-sql/pglite";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import * as OTPAuth from "otpauth";
import sharp from "sharp";
import { testDatabase } from "./fixtures/community-db";
import { migrate, type Database } from "../server/community/db";
import { installAccountRoutes } from "../server/community/account";
import {
  installCommunityRoutes,
  installMediaRoutes,
} from "../server/community/routes";
import {
  cleanupAccountMedia,
  closeMediaSweep,
} from "../server/community/accountData";
import {
  captureChartDocument,
  cloneChartDocument,
} from "../src/community/chartDocument";
import { seal } from "../server/community/security";

const engine = new PGlite(),
  actual = testDatabase(engine);
let rollback = false;
const db: Database = {
  query: actual.query,
  transaction: (run) =>
    actual.transaction(async (tx) => {
      const result = await run(tx);
      if (rollback) {
        rollback = false;
        throw new Error("Simulated commit failure");
      }
      return result;
    }),
};
const api = "/api/community",
  pass = "a sufficiently long test password";
const previous = {
  key: process.env.COMMUNITY_ENCRYPTION_KEY,
  media: process.env.COMMUNITY_MEDIA_DIR,
  origin: process.env.APP_ORIGIN,
};
let root: string,
  base: string,
  server: any,
  clock = Date.now();
const messages: Array<{ email: string; url: string }> = [];
interface Actor {
  id: string;
  email: string;
  cookie: string;
}
async function call(path: string, actor?: Actor, method = "GET", body?: any) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "X-H00K-Request": "1",
      ...(actor ? { Cookie: actor.cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { res, data: await res.json().catch(() => null) };
}
function actorFrom(res: Response, data: any): Actor {
  return {
    id: data.user.uid,
    email: data.user.email,
    cookie: res.headers.getSetCookie()[0].split(";")[0],
  };
}
async function register(name = "Trader") {
  const result = await call("/api/account/register", undefined, "POST", {
    email: randomUUID() + "@example.test",
    displayName: name,
    password: pass,
  });
  assert.equal(result.res.status, 201, JSON.stringify(result.data));
  return actorFrom(result.res, result.data);
}
async function enroll(a: Actor) {
  const setup = await call("/api/account/mfa/setup", a, "POST", {
    password: pass,
  });
  assert.equal(setup.res.status, 200, JSON.stringify(setup.data));
  const totp = new OTPAuth.TOTP({ secret: setup.data.secret });
  const code = () => {
    clock += 30_000;
    return totp.generate({ timestamp: clock });
  };
  const confirmed = await call("/api/account/mfa/confirm", a, "POST", {
    code: code(),
  });
  assert.equal(confirmed.res.status, 200, JSON.stringify(confirmed.data));
  return {
    codes: confirmed.data.recoveryCodes as string[],
    code,
    secret: setup.data.secret,
  };
}
function chart() {
  return captureChartDocument({
    symbol: "BTCUSDT",
    exchange: "binance",
    marketType: "futures",
    timeframe: "1m",
    capturedAt: Date.now(),
    candles: Array.from({ length: 60 }, (_, i) => ({
      time: Math.floor(Date.now() / 60000) * 60 - 3600 + i * 60,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 10,
    })),
    markers: [
      {
        id: "entry",
        type: "entry",
        price: 100,
        label: "Вхід",
        color: "#38bdf8",
      },
    ],
    drawings: [],
  });
}
async function image(a: Actor) {
  const bytes = await sharp({
    create: { width: 12, height: 12, channels: 3, background: "#369" },
  })
    .png()
    .toBuffer();
  const res = await fetch(base + api + "/media", {
    method: "POST",
    headers: {
      Cookie: a.cookie,
      "X-H00K-Request": "1",
      "Content-Type": "image/png",
    },
    body: bytes,
  });
  const data: any = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  return data.id;
}
async function download(url: string, a: Actor) {
  const res = await fetch(base + url, { headers: { Cookie: a.cookie } });
  assert.equal(
    res.status,
    200,
    await (res.status === 200 ? Promise.resolve("") : res.text()),
  );
  const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
  return {
    res,
    text,
    lines: text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  };
}
test.before(async () => {
  root = await fs.mkdtemp(
    new URL("../.test-account-lifecycle-", import.meta.url).pathname,
  );
  process.env.COMMUNITY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.COMMUNITY_MEDIA_DIR = root;
  await migrate(db);
  await migrate(db);
});
test.beforeEach(async () => {
  rollback = false;
  clock = Date.now();
  const app = express();
  installMediaRoutes(app, () => db);
  app.use(express.json({ limit: "2mb" }));
  installAccountRoutes(
    app,
    () => db,
    async (email, _subject, url) => {
      messages.push({ email, url });
    },
    () => clock,
  );
  installCommunityRoutes(app, () => db);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
  process.env.APP_ORIGIN = base;
});
test.afterEach(async () => {
  await new Promise<void>((resolve) => server.close(resolve));
});
test.after(async () => {
  await closeMediaSweep();
  await engine.close();
  await fs.rm(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries({
    COMMUNITY_ENCRYPTION_KEY: previous.key,
    COMMUNITY_MEDIA_DIR: previous.media,
    APP_ORIGIN: previous.origin,
  }))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

test("TOTP and random recovery codes are single-use and belong to one account", async () => {
  const a = await register(),
    b = await register(),
    mfa = await enroll(a);
  await enroll(b);
  assert.equal(mfa.codes.length, 10);
  assert.equal(new Set(mfa.codes).size, 10);
  const stored = await db.query(
    "SELECT code_hash,used_at FROM hc_recovery_codes WHERE user_id=$1",
    [a.id],
  );
  assert.equal(stored.rows.length, 10);
  assert.ok(
    stored.rows.every(
      (row) =>
        /^[a-f0-9]{64}$/.test(row.code_hash) &&
        !mfa.codes.includes(row.code_hash) &&
        !row.used_at,
    ),
  );
  const code = mfa.code();
  const concurrent = await Promise.all(
    [1, 2].map(() =>
      call("/api/account/login", undefined, "POST", {
        email: a.email,
        password: pass,
        code,
      }),
    ),
  );
  assert.deepEqual(concurrent.map((r) => r.res.status).sort(), [200, 401]);
  const replay = await call("/api/account/login", undefined, "POST", {
    email: a.email,
    password: pass,
    code,
  });
  assert.equal(replay.res.status, 401);
  assert.equal(
    (
      await call("/api/account/login", undefined, "POST", {
        email: b.email,
        password: pass,
        recoveryCode: mfa.codes[0],
      })
    ).res.status,
    401,
  );
  const recovered = await call("/api/account/login", undefined, "POST", {
    email: a.email,
    password: pass,
    recoveryCode: mfa.codes[0],
  });
  assert.equal(recovered.res.status, 200);
  assert.equal(recovered.data.security.strong, true);
  assert.equal(
    (
      await call("/api/account/login", undefined, "POST", {
        email: a.email,
        password: pass,
        recoveryCode: mfa.codes[0],
      })
    ).res.status,
    401,
  );
  assert.equal(
    (await call("/api/account/me", a)).data.security.recoveryCodesRemaining,
    9,
  );
  const notices = await db.query(
    "SELECT body FROM hc_notifications WHERE owner_id=$1 AND type='security'",
    [a.id],
  );
  assert.ok(
    notices.rows.some((row) => row.body.action === "recovery-code-used"),
  );
});

test("MFA enrollment is bound to its session and replacing a factor requires a fresh proof", async () => {
  const a = await register();
  const another = await call("/api/account/login", undefined, "POST", {
    email: a.email,
    password: pass,
  });
  const second = actorFrom(another.res, another.data);
  const setup = await call("/api/account/mfa/setup", a, "POST", {
    password: pass,
  });
  const totp = new OTPAuth.TOTP({ secret: setup.data.secret });
  clock += 30_000;
  const code = totp.generate({ timestamp: clock });
  assert.equal(
    (await call("/api/account/mfa/confirm", second, "POST", { code })).res
      .status,
    403,
  );
  const confirmed = await call("/api/account/mfa/confirm", a, "POST", { code });
  assert.equal(confirmed.res.status, 200);
  assert.equal((await call("/api/account/me", second)).data.user, null);
  assert.equal(
    (await call("/api/account/mfa/setup", a, "POST", { password: pass })).res
      .status,
    401,
    "an already strong session must not replace the existing factor by itself",
  );
  const replacement = await call("/api/account/mfa/setup", a, "POST", {
    password: pass,
    recoveryCode: confirmed.data.recoveryCodes[0],
  });
  assert.equal(replacement.res.status, 200);
  clock += 901_000;
  assert.equal(
    (
      await call("/api/account/mfa/confirm", a, "POST", {
        code: new OTPAuth.TOTP({ secret: replacement.data.secret }).generate({
          timestamp: clock,
        }),
      })
    ).res.status,
    403,
  );
});

test("regeneration revokes old recovery codes; recovery never bypasses password reset MFA", async () => {
  const a = await register(),
    mfa = await enroll(a);
  assert.equal(
    (
      await call("/api/account/mfa/recovery-codes", a, "POST", {
        password: "wrong",
        code: mfa.code(),
      })
    ).res.status,
    401,
  );
  const replacement = await call("/api/account/mfa/recovery-codes", a, "POST", {
    password: pass,
    code: mfa.code(),
  });
  assert.equal(replacement.res.status, 200);
  assert.equal(
    (
      await call("/api/account/login", undefined, "POST", {
        email: a.email,
        password: pass,
        recoveryCode: mfa.codes[0],
      })
    ).res.status,
    401,
  );
  await call("/api/account/reset/request", undefined, "POST", {
    email: a.email,
  });
  const token = new URL(
    messages.filter((m) => m.email === a.email).at(-1)!.url,
  ).searchParams.get("reset");
  assert.equal(
    (
      await call("/api/account/reset", undefined, "POST", {
        token,
        password: "my updated long password",
      })
    ).res.status,
    401,
  );
  assert.equal(
    (
      await call("/api/account/reset", undefined, "POST", {
        token,
        password: "my updated long password",
        recoveryCode: replacement.data.recoveryCodes[0],
      })
    ).res.status,
    200,
  );
  assert.equal((await call("/api/account/me", a)).data.user, null);
  assert.equal(
    (
      await call("/api/account/login", undefined, "POST", {
        email: a.email,
        password: "my updated long password",
        recoveryCode: replacement.data.recoveryCodes[0],
      })
    ).res.status,
    401,
  );
  assert.equal(
    (
      await call("/api/account/login", undefined, "POST", {
        email: a.email,
        password: "my updated long password",
        recoveryCode: replacement.data.recoveryCodes[1],
      })
    ).res.status,
    200,
  );
});

test("sessions have safe public IDs; password changes rotate the cookie and revoke old sessions", async () => {
  const a = await register(),
    b = await register();
  const other = await call("/api/account/login", undefined, "POST", {
    email: a.email,
    password: pass,
  });
  const second = actorFrom(other.res, other.data);
  const list = await call("/api/account/sessions", a);
  assert.equal(list.data.items.length, 2);
  assert.ok(list.data.items.every((s: any) => s.id && !s.token_hash));
  const id = list.data.items.find((s: any) => !s.current).id;
  assert.equal(
    (await call("/api/account/sessions/" + id, b, "DELETE")).res.status,
    404,
  );
  assert.equal(
    (await call("/api/account/sessions/" + id, a, "DELETE")).res.status,
    200,
  );
  assert.equal((await call("/api/account/me", second)).data.user, null);
  const changed = await call("/api/account/password", a, "POST", {
    password: pass,
    newPassword: "a different long password",
  });
  assert.equal(changed.res.status, 200);
  assert.notEqual(
    changed.res.headers.getSetCookie()[0].split(";")[0],
    a.cookie,
  );
  assert.equal((await call("/api/account/me", a)).data.user, null);
  assert.equal(
    (
      await call("/api/account/login", undefined, "POST", {
        email: a.email,
        password: pass,
      })
    ).res.status,
    401,
  );
  const login = await call("/api/account/login", undefined, "POST", {
    email: a.email,
    password: "a different long password",
  });
  assert.equal(login.res.status, 200);
});

test("personal exports include owned records and images, exclude secrets, and bind one-use tickets to the session", async () => {
  const a = await register(),
    b = await register();
  const media = await image(a),
    document = chart();
  const created = await call(api + "/charts", a, "POST", { document });
  await call(api + "/items", a, "POST", {
    kind: "post",
    audience: "private",
    chartId: created.data.id,
    body: { text: "my private analysis", photos: [media] },
  });
  await call(api + "/items", b, "POST", {
    kind: "post",
    audience: "private",
    body: { text: "other person's private record" },
  });
  const connection = randomUUID(),
    secret = "this-is-an-exchange-credential";
  await db.query(
    "INSERT INTO hc_connections(id,owner_id,exchange,account_hash,credential) VALUES($1,$2,'bybit',$3,$4)",
    [connection, a.id, randomUUID(), seal(secret, a.id + ":" + connection)],
  );
  assert.equal(
    (await call("/api/account/export", a, "POST", { password: "wrong" })).res
      .status,
    401,
  );
  const ticket = await call("/api/account/export", a, "POST", {
    password: pass,
  });
  assert.equal(ticket.res.status, 200);
  assert.equal(
    (await fetch(base + ticket.data.url, { headers: { Cookie: b.cookie } }))
      .status,
    404,
  );
  const second = await call("/api/account/login", undefined, "POST", {
    email: a.email,
    password: pass,
  });
  assert.equal(
    (
      await fetch(base + ticket.data.url, {
        headers: { Cookie: actorFrom(second.res, second.data).cookie },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(base + ticket.data.url, {
        method: "HEAD",
        headers: { Cookie: a.cookie },
      })
    ).status,
    405,
  );
  const exported = await download(ticket.data.url, a);
  assert.equal(exported.res.headers.get("Cache-Control"), "private, no-store");
  assert.match(exported.res.headers.get("Content-Disposition")!, /attachment/);
  assert.match(exported.text, /my private analysis/);
  assert.ok(
    !/other person's private record|"(?:password_hash|mfa_secret|credential|token_hash)":/.test(
      exported.text,
    ),
    "export must exclude other people and secret fields",
  );
  assert.ok(!exported.text.includes(secret));
  assert.ok(
    exported.lines.some((line) => line.section === "media" && line.record.data),
  );
  assert.equal(exported.lines.at(-1).section, "complete");
  assert.equal(
    (await fetch(base + ticket.data.url, { headers: { Cookie: a.cookie } }))
      .status,
    404,
  );
});

test("export pages cover all owned rows and do not reopen a revoked chart source", async () => {
  const a = await register(),
    b = await register();
  for (let i = 0; i < 113; i++)
    await db.query(
      "INSERT INTO hc_items(id,owner_id,kind,body) VALUES($1,$2,'plan',$3)",
      [randomUUID(), a.id, { text: "paged-own-" + i }],
    );
  await call(api + "/friends/" + a.id, b, "POST", {});
  await call(api + "/friends/" + b.id, a, "POST", {});
  const d = chart(),
    source = await call(api + "/charts", b, "POST", { document: d });
  await call(api + "/items", b, "POST", {
    kind: "post",
    audience: "friends",
    chartId: source.data.id,
    body: { text: "source" },
  });
  const fork = await call(api + "/charts", a, "POST", {
    document: cloneChartDocument(d),
    parentId: source.data.id,
  });
  assert.equal(fork.res.status, 201);
  await call(api + "/archives", a, "POST", {
    id: "arch_" + randomUUID(),
    sourceChartId: source.data.id,
    chartDocument: d,
    notes: "must stay unavailable",
  });
  await call(api + "/friends/" + a.id, b, "DELETE");
  const ticket = await call("/api/account/export", a, "POST", {
    password: pass,
  });
  const result = await download(ticket.data.url, a);
  assert.equal(
    result.lines.filter((line) => line.section === "items").length,
    113,
  );
  assert.doesNotMatch(result.text, /must stay unavailable/);
  assert.equal(
    result.lines.filter((line) => line.section === "charts").length,
    0,
  );
  assert.equal(result.lines.at(-1).record.omittedUnavailableSources, 2);
});

test("deletion erases account data, revokes descendants and transfers groups while queueing disk and market cleanup", async () => {
  const a = await register("Deleted Trader"),
    b = await register(),
    d = chart(),
    media = await image(a);
  await call(api + "/friends/" + b.id, a, "POST", {});
  await call(api + "/friends/" + a.id, b, "POST", {});
  const source = await call(api + "/charts", a, "POST", { document: d });
  await call(api + "/items", a, "POST", {
    kind: "post",
    audience: "friends",
    chartId: source.data.id,
    body: { text: "personal text to erase", photos: [media] },
  });
  const fork = await call(api + "/charts", b, "POST", {
    document: d,
    parentId: source.data.id,
  });
  assert.equal(fork.res.status, 201);
  const group = await call(api + "/conversations", a, "POST", {
    title: "Shared test",
    members: [b.id],
  });
  assert.equal(group.res.status, 201);
  const connection = randomUUID();
  await db.query(
    "INSERT INTO hc_connections(id,owner_id,exchange,account_hash,credential) VALUES($1,$2,'bybit',$3,'secret-to-delete')",
    [connection, a.id, randomUUID()],
  );
  await db.query(
    "INSERT INTO hc_trades(connection_id,source_id,owner_id,symbol,currency,pnl,closed_at,source) VALUES($1,'1',$2,'BTCUSDT','USDT',10,now(),'{}')",
    [connection, a.id],
  );
  await db.query(
    "INSERT INTO hc_trade_notes(connection_id,source_id,owner_id,body) VALUES($1,'1',$2,'{\"reason\":\"private\"}')",
    [connection, a.id],
  );
  const preview = await call("/api/account/delete/preview", a);
  assert.equal(preview.data.counts.groups, 1);
  assert.equal(preview.data.counts.media, 1);
  assert.equal(
    (
      await call("/api/account/delete", a, "POST", {
        password: "wrong",
        confirm: "DELETE",
      })
    ).res.status,
    401,
  );
  assert.equal((await call("/api/account/me", a)).data.user.uid, a.id);
  const deleted = await call("/api/account/delete", a, "POST", {
    password: pass,
    confirm: "DELETE",
  });
  assert.equal(deleted.res.status, 200, JSON.stringify(deleted.data));
  assert.equal(deleted.data.backgroundCleanup, "queued");
  assert.equal((await call("/api/account/me", a)).data.user, null);
  assert.equal(
    (
      await call("/api/account/login", undefined, "POST", {
        email: a.email,
        password: pass,
      })
    ).res.status,
    401,
  );
  assert.equal(
    (await call(api + "/charts/" + fork.data.id, b)).res.status,
    404,
  );
  assert.equal((await call(api + "/profiles/" + a.id, b)).res.status, 404);
  for (const table of [
    "hc_connections",
    "hc_trades",
    "hc_trade_notes",
    "hc_media",
    "hc_archives",
  ]) {
    assert.equal(
      (
        await db.query(
          `SELECT count(*)::integer AS count FROM ${table} WHERE owner_id=$1`,
          [a.id],
        )
      ).rows[0].count,
      0,
      table,
    );
  }
  const remaining = await db.query("SELECT * FROM hc_users WHERE id=$1", [
    a.id,
  ]);
  assert.deepEqual(remaining.rows[0].profile, {});
  assert.notEqual(remaining.rows[0].email, a.email);
  assert.ok(remaining.rows[0].deleted_at);
  const items = await db.query(
    "SELECT body,deleted FROM hc_items WHERE owner_id=$1",
    [a.id],
  );
  assert.ok(
    items.rows.every((row) => row.deleted && JSON.stringify(row.body) === "{}"),
  );
  assert.equal(
    (await call(api + "/conversations", b)).data.items.find(
      (item: any) => item.id === group.data.id,
    ).role,
    "owner",
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
    (
      await fetch(base + api + "/media/" + media, {
        headers: { Cookie: b.cookie },
      })
    ).status,
    404,
  );
  await fs.access(root + "/" + media + ".webp");
  assert.equal(await cleanupAccountMedia(db), 1);
  await assert.rejects(fs.access(root + "/" + media + ".webp"));
  assert.equal(await cleanupAccountMedia(db), 0);
});

test("failed commits do not report published content or partially delete an account", async () => {
  const a = await register();
  rollback = true;
  const failed = await call(api + "/items", a, "POST", {
    kind: "post",
    audience: "public",
    body: { text: "must rollback" },
  });
  assert.equal(failed.res.status, 503);
  assert.equal(
    (await db.query("SELECT id FROM hc_items WHERE owner_id=$1", [a.id])).rows
      .length,
    0,
  );
  await call(api + "/items", a, "POST", {
    kind: "post",
    audience: "private",
    body: { text: "must survive failed deletion" },
  });
  rollback = true;
  const deleted = await call("/api/account/delete", a, "POST", {
    password: pass,
    confirm: "DELETE",
  });
  assert.equal(deleted.res.status, 503);
  assert.equal((await call("/api/account/me", a)).data.user.uid, a.id);
  assert.equal(
    (
      await db.query(
        "SELECT owner_id FROM hc_account_cleanup WHERE owner_id=$1",
        [a.id],
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (await db.query("SELECT body FROM hc_items WHERE owner_id=$1", [a.id]))
      .rows[0].body.text,
    "must survive failed deletion",
  );
});

test("old unindexed images are cleaned after interrupted uploads, while recent files are retained", async () => {
  const old = randomUUID() + ".webp",
    recent = randomUUID() + ".webp";
  await fs.writeFile(root + "/" + old, "interrupted upload");
  await fs.writeFile(root + "/" + recent, "in progress");
  await fs.utimes(
    root + "/" + old,
    new Date(Date.now() - 7200_000),
    new Date(Date.now() - 7200_000),
  );
  await closeMediaSweep();
  await cleanupAccountMedia(db);
  await assert.rejects(fs.access(root + "/" + old));
  await fs.access(root + "/" + recent);
});
