import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { installCommunityProxy } from "../server/community/proxy";
test("public profile, assets and read API retain security headers through the compatibility proxy", async () => {
  const source = express(), csp = "default-src 'none'; script-src 'self'; connect-src 'self'";
  source.get(["/u/ivan", "/profile-assets/assets/fixture.js", "/api/public/profiles/ivan"], (req, res) => {
    res.set({ "Content-Security-Policy": csp, "Cache-Control": "private, no-store" });
    res.json({ path: req.path });
  });
  const upstream = source.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => upstream.once("listening", resolve));
  const previous = process.env.COMMUNITY_INTERNAL_ORIGIN;
  process.env.COMMUNITY_INTERNAL_ORIGIN = "http://127.0.0.1:" + (upstream.address() as any).port;
  const app = express(); installCommunityProxy(app);
  const proxy = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => proxy.once("listening", resolve));
  try {
    for (const path of ["/u/ivan", "/profile-assets/assets/fixture.js", "/api/public/profiles/ivan"]) {
      const response = await fetch("http://127.0.0.1:" + (proxy.address() as any).port + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-security-policy"), csp);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal((await response.json()).path, path);
    }
  } finally {
    await Promise.all([
      new Promise<void>(resolve => proxy.close(() => resolve())),
      new Promise<void>(resolve => upstream.close(() => resolve())),
    ]);
    if (previous === undefined) delete process.env.COMMUNITY_INTERNAL_ORIGIN;
    else process.env.COMMUNITY_INTERNAL_ORIGIN = previous;
  }
});
test("Community proxy forwards attachment headers and streams before the export finishes", async () => {
  let release!: () => void;
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = express();
  source.get("/api/account/export/fixture", async (_req, res) => {
    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="fixture.jsonl.gz"',
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    });
    res.write("first-chunk-" + "x".repeat(2048));
    await finish;
    res.end("last-chunk");
  });
  const upstream = source.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  const previous = process.env.COMMUNITY_INTERNAL_ORIGIN;
  process.env.COMMUNITY_INTERNAL_ORIGIN =
    "http://127.0.0.1:" + (upstream.address() as any).port;
  const app = express();
  installCommunityProxy(app);
  const proxy = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => proxy.once("listening", resolve));
  try {
    const response = await fetch(
      "http://127.0.0.1:" +
        (proxy.address() as any).port +
        "/api/account/export/fixture",
      { signal: AbortSignal.timeout(3000) },
    );
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="fixture.jsonl.gz"',
    );
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const reader = response.body!.getReader(),
      first = await reader.read();
    assert.ok(new TextDecoder().decode(first.value).startsWith("first-chunk-"));
    release();
    let tail = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      tail += new TextDecoder().decode(part.value);
    }
    assert.match(tail, /last-chunk/);
  } finally {
    release();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    if (previous === undefined) delete process.env.COMMUNITY_INTERNAL_ORIGIN;
    else process.env.COMMUNITY_INTERNAL_ORIGIN = previous;
  }
});
