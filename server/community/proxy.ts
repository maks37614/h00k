import express from "express";
import type { Express } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
/** Stream no market data through Community. This bounded proxy precedes the market JSON parser. */
export function installCommunityProxy(app: Express) {
  let active = 0;
  app.use(
    ["/api/account", "/api/community", "/api/public/profiles", "/u", "/profile-assets"],
    (_req, res, next) => {
      if (active >= 8) {
        res.status(503).json({
          success: false,
          error: "Community зайняте. Повторіть запит.",
        });
        return;
      }
      active++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          active--;
        }
      };
      res.once("finish", release);
      res.once("close", release);
      next();
    },
    express.raw({ type: () => true, limit: "6mb" }),
    async (req, res) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        req.originalUrl.startsWith("/api/account/export/") ? 320_000 : 25_000,
      );
      timer.unref();
      const close = () => controller.abort();
      res.once("close", close);
      const origin =
        process.env.COMMUNITY_INTERNAL_ORIGIN ?? "http://127.0.0.1:3001";
      try {
        const headers = new Headers();
        for (const name of [
          "content-type",
          "cookie",
          "origin",
          "x-h00k-request",
        ]) {
          const value = req.get(name);
          if (value) headers.set(name, value);
        }
        headers.set(
          "X-Forwarded-For",
          req.ip ?? req.socket.remoteAddress ?? "unknown",
        );
        const response = await fetch(origin + req.originalUrl, {
          method: req.method,
          headers,
          ...(["GET", "HEAD"].includes(req.method) ? {} : { body: req.body }),
          redirect: "manual",
          signal: controller.signal,
        });
        res.status(response.status);
        for (const name of [
          "content-type",
          "cache-control",
          "x-content-type-options",
          "content-disposition",
          "referrer-policy",
          "content-security-policy",
        ]) {
          const value = response.headers.get(name);
          if (value) res.set(name, value);
        }
        for (const cookie of response.headers.getSetCookie())
          res.append("Set-Cookie", cookie);
        if (response.body)
          await pipeline(Readable.fromWeb(response.body as any), res);
        else res.end();
      } catch {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.status(503).json({
          success: false,
          error:
            "Community тимчасово недоступне. Ринкові графіки працюють окремо.",
        });
      } finally {
        clearTimeout(timer);
        res.off("close", close);
      }
    },
  );
}
