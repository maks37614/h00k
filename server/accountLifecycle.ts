import type { Express } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { postgres, type Database } from "./community/db";
import { accountFor } from "./community/session";
import { consumeExportTicket } from "./community/exportTickets";
import { fail, RequestLimits, uuid } from "./community/security";
import { markAccountDeleted } from "./deletedAccounts";
import { eraseUserAlerts, getAllAlerts, getAlertHistory } from "./alertService";
import {
  eraseUserSurveillance,
  loadSurveillanceList,
} from "./surveillanceService";
import { eraseUserTelegram, loadUserTelegram } from "./userTelegram";
import { notificationRouter } from "./notificationRouter";
import { eraseTelegramLinks } from "./telegramLinkService";
import {
  eraseTelegramDeliveries,
  exportTelegramDeliveries,
} from "./telegramDelivery";

export function purgeMarketAccount(userId: string) {
  uuid(userId);
  markAccountDeleted(userId);
  eraseUserTelegram(userId);
  eraseTelegramLinks(userId);
  eraseTelegramDeliveries(userId);
  eraseUserAlerts(userId);
  eraseUserSurveillance(userId);
  notificationRouter.forgetUser(userId);
}
export async function cleanupMarketAccounts(
  db: Database,
  purge: (id: string) => void = purgeMarketAccount,
) {
  const jobs = await db.transaction(async (tx) => {
    const { rows } =
      await tx.query(`SELECT c.owner_id FROM hc_account_cleanup c JOIN hc_users u ON u.id=c.owner_id
      WHERE c.market_pending AND u.deleted_at IS NOT NULL AND (c.lease_until IS NULL OR c.lease_until<now())
      ORDER BY c.created_at LIMIT 2 FOR UPDATE OF c SKIP LOCKED`);
    for (const row of rows)
      await tx.query(
        "UPDATE hc_account_cleanup SET lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE owner_id=$1",
        [row.owner_id],
      );
    return rows;
  });
  let completed = 0;
  for (const job of jobs) {
    try {
      purge(uuid(job.owner_id));
      await db.query(
        "UPDATE hc_account_cleanup SET market_pending=false,lease_until=NULL,completed_at=now() WHERE owner_id=$1",
        [job.owner_id],
      );
      completed++;
    } catch {
      await db.query(
        "UPDATE hc_account_cleanup SET lease_until=now()+interval '30 seconds' WHERE owner_id=$1",
        [job.owner_id],
      );
    }
  }
  return completed;
}
export function installAccountLifecycle(
  app: Express,
  getDb: () => Database = postgres,
) {
  const limits = new RequestLimits();
  let exporting = false;
  app.get("/api/user-data/export/:ticket", async (req, res) => {
    if (req.method !== "GET") {
      res.set("Allow", "GET").status(405).end();
      return;
    }
    let slot = false;
    try {
      res.set({
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      const db = getDb(),
        account = await accountFor(db, req);
      if (!account) fail("Увійдіть у свій акаунт", 401);
      limits.take(account.id, 5, 3600_000);
      if (exporting) fail("Інший експорт ще триває", 429);
      exporting = true;
      slot = true;
      await consumeExportTicket(db, account, req.params.ticket, "market");
      const stored = loadUserTelegram().get(account.id);
      const telegram = stored
        ? {
            mode: stored.mode,
            botId: stored.botId,
            chatId: stored.chatId,
            username: stored.username,
            language: stored.language,
            confirmedAt: stored.confirmedAt,
          }
        : null;
      const parts = [
        {
          section: "manifest",
          record: {
            format: "h00k-personal-data",
            version: 1,
            scope: "market",
            ownerId: account.id,
            startedAt: new Date().toISOString(),
          },
        },
        ...getAllAlerts(account.id).map((record) => ({
          section: "alerts",
          record,
        })),
        ...getAlertHistory(account.id).map((record) => ({
          section: "alert_history",
          record,
        })),
        ...loadSurveillanceList(account.id).map((record) => ({
          section: "surveillance",
          record,
        })),
        { section: "telegram", record: telegram },
        ...exportTelegramDeliveries(account.id).map((record) => ({
          section: "telegram_delivery",
          record,
        })),
        {
          section: "complete",
          record: { finishedAt: new Date().toISOString() },
        },
      ];
      // Never serialize legacy embedded bot credentials, even in an owner's export.
      const lines = parts.map(
        (item) =>
          JSON.stringify(item, (key, value) =>
            /botToken|secret|codeHash/i.test(key) ? undefined : value,
          ) + "\n",
      );
      res.set({
        "Content-Type": "application/gzip",
        "Content-Disposition":
          'attachment; filename="h00k-market-data.jsonl.gz"',
      });
      await pipeline(Readable.from(lines), createGzip(), res);
    } catch (error: any) {
      if (res.headersSent) res.destroy();
      else
        res.status(error.status ?? 503).json({
          success: false,
          error: error.status
            ? error.message
            : "Експорт даних тимчасово недоступний",
        });
    } finally {
      if (slot) exporting = false;
    }
  });
}
/** One small queue poll, outside market ticks and disabled when native storage is absent. */
export function startAccountCleanup(getDb: () => Database = postgres) {
  let running = false;
  const tick = async () => {
    if (running || !process.env.DATABASE_URL) return;
    running = true;
    try {
      await cleanupMarketAccounts(getDb());
    } catch {
      console.warn("Account data cleanup will retry");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
