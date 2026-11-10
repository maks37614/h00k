import "dotenv/config";
import express from "express";
import { postgres, migrate, closeDatabase } from "./server/community/db";
import { installAccountRoutes } from "./server/community/account";
import {
  installCommunityRoutes,
  installMediaRoutes,
} from "./server/community/routes";
import { syncBybit } from "./server/community/bybit";
import { installPublicProfiles } from "./server/community/publicProfiles";
import {
  cleanupAccountMedia,
  closeMediaSweep,
} from "./server/community/accountData";
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.COMMUNITY_TRUST_PROXY ?? "loopback");
app.get("/api/community-health", (_req, res) =>
  res.json({ status: "ok", service: "community" }),
);
installPublicProfiles(app, postgres);
installMediaRoutes(app, postgres);
app.use(express.json({ limit: "2mb" }));
installAccountRoutes(app, postgres);
installCommunityRoutes(app, postgres);
if (process.argv.includes("--migrate")) {
  await migrate(postgres());
  await closeDatabase();
} else {
  const server = app.listen(
    Number(process.env.COMMUNITY_PORT ?? 3001),
    process.env.COMMUNITY_HOST ?? "127.0.0.1",
    () => console.log("Community service ready"),
  );
  let running = false;
  let cleaning = false;
  const cleanupTimer = setInterval(async () => {
    if (cleaning) return;
    cleaning = true;
    try {
      await cleanupAccountMedia(postgres());
    } catch {
      console.warn("Community data cleanup will retry");
    } finally {
      cleaning = false;
    }
  }, 5000);
  cleanupTimer.unref();
  const timer = setInterval(async () => {
    if (running || process.env.COMMUNITY_SYNC_ENABLED !== "1") return;
    running = true;
    try {
      const db = postgres(),
        { rows } = await db.query(
          `SELECT id,owner_id FROM hc_connections WHERE credential<>'' AND status<>'disconnected' AND (synced_at IS NULL OR synced_at<now()-interval '60 seconds') ORDER BY synced_at NULLS FIRST LIMIT 2`,
        );
      for (const row of rows)
        try {
          await syncBybit(db, row.id, row.owner_id);
        } catch {
          console.warn("A read-only synchronization is unavailable");
        }
    } catch {
      console.warn("Community worker unavailable");
    } finally {
      running = false;
    }
  }, 60_000);
  timer.unref();
  process.on("SIGTERM", () => {
    clearInterval(timer);
    clearInterval(cleanupTimer);
    server.close(() => {
      void closeMediaSweep();
      void closeDatabase();
    });
  });
}
