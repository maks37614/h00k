import { checkAlertsOnce, loadAlerts, getAllAlerts } from './alertService';
import { checkCoinSurveillance, getAllActiveSurveillanceCoins, findSurveillanceCoinById, commitSurveillanceCheck, flushDeferredSurveillanceChecks } from './surveillanceService';
import { candleCloseCheckPlanner } from './surveillance/candleCloseCheckPlanner';
import { runBackgroundFormationScans } from './marketService';
import { getUserTelegram } from './userTelegram';
import { surveillanceManager } from './surveillance/surveillanceManager';

export interface CronJobStatus {
  id: string;
  name: string;
  intervalMs: number;
  lastRunAt: string | null;
  lastDurationMs: number;
  runCount: number;
  errorCount: number;
  lastError: string | null;
  isRunning: boolean;
  enabled: boolean;
}

export interface CronSystemStatus {
  uptimeSeconds: number;
  startedAt: string;
  isHealthy: boolean;
  jobs: Record<string, CronJobStatus>;
  stats: {
    totalAlertsMonitored: number;
    activeAlertsCount: number;
    surveillanceCoinsMonitored: number;
    telegramConfigured: boolean;
  };
}

class CronManager {
  private startTime: number = Date.now();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  // Continue large surveillance passes fairly instead of always starting at user #1.
  private surveillanceCursor = 0;

  private jobs: Record<string, CronJobStatus> = {
    price_alerts: {
      id: 'price_alerts',
      name: 'Цінові сповіщення (Binance & Bybit)',
      intervalMs: 5000,
      lastRunAt: null,
      lastDurationMs: 0,
      runCount: 0,
      errorCount: 0,
      lastError: null,
      isRunning: false,
      enabled: true,
    },
    surveillance: {
      id: 'surveillance',
      name: '24/7 Нагляд за ринком (Імпульси, Сплески, Рівні)',
      intervalMs: 15000,
      lastRunAt: null,
      lastDurationMs: 0,
      runCount: 0,
      errorCount: 0,
      lastError: null,
      isRunning: false,
      enabled: true,
    },
    screener_patterns: {
      id: 'screener_patterns',
      name: 'Скринер патернів високої впевненості (≥88%)',
      intervalMs: 60000,
      lastRunAt: null,
      lastDurationMs: 0,
      runCount: 0,
      errorCount: 0,
      lastError: null,
      isRunning: false,
      enabled: true,
    },
  };

  public init() {
    console.log('[CRON] Initializing unified background notification cron system...');
    try {
      surveillanceManager.start();
    } catch (e) {
      console.error('[CRON] Error starting surveillanceManager:', e);
    }
    this.startPriceAlertsCron();
    this.startSurveillanceCron();
    this.startScreenerCron();
  }

  // --- 1. Price Alerts Cron (Every 5s) ---
  private startPriceAlertsCron() {
    const job = this.jobs.price_alerts;
    if (this.timers.has(job.id)) clearInterval(this.timers.get(job.id)!);

    const run = async () => {
      if (job.isRunning || !job.enabled) return;
      job.isRunning = true;
      const start = Date.now();
      try {
        await checkAlertsOnce();
        job.lastRunAt = new Date().toISOString();
        job.lastDurationMs = Date.now() - start;
        job.runCount++;
        job.lastError = null;
      } catch (err: any) {
        job.errorCount++;
        job.lastError = err?.message || 'Помилка виконання перевірки цінових сповіщень';
        console.error('[CRON:price_alerts] Error:', err);
      } finally {
        job.isRunning = false;
      }
    };

    // Run first iteration after 1.5s
    setTimeout(run, 1500);
    const timer = setInterval(run, job.intervalMs);
    this.timers.set(job.id, timer);
  }

  // --- 2. Surveillance Cron: candle-aware, bounded and batched ---
  private startSurveillanceCron() {
    const job = this.jobs.surveillance;
    if (this.timers.has(job.id)) clearInterval(this.timers.get(job.id)!);

    const run = async () => {
      if (job.isRunning || !job.enabled) return;
      job.isRunning = true;
      const start = Date.now();
      let lastPersistAt = start;
      try {
        const activeItems = getAllActiveSurveillanceCoins();
        const activeKeys = new Set(activeItems.map(({ userId, coin }) =>
          JSON.stringify([userId, coin.id])));
        candleCloseCheckPlanner.prune(activeKeys);
        const count = activeItems.length;
        if (count) {
          const first = this.surveillanceCursor % count;
          let examined = 0;
          for (; examined < count; examined++) {
            const { userId, coin } = activeItems[(first + examined) % count];
            const key = JSON.stringify([userId, coin.id]);
            const now = Date.now();
            if (!candleCloseCheckPlanner.due(key, coin.config, now)) continue;
            try {
              // A paused/deleted coin must not be resurrected by an older snapshot.
              const fresh = findSurveillanceCoinById(coin.id, userId)?.coin;
              if (!fresh || !fresh.isActive) continue;
              const { coin: checked } = await checkCoinSurveillance(fresh, {
                forceCheck: false, forceNotify: false,
              });
              // Routine observations are written together, while a real Telegram
              // delivery is persisted immediately by commitSurveillanceCheck.
              const committed = commitSurveillanceCheck(checked, { deferPersist: true });
              if (!committed || !committed.lastCheckedAt
                || committed.lastCheckedAt === fresh.lastCheckedAt
                || !candleCloseCheckPlanner.hasLatestClosedBars(
                  fresh.config, committed.state?.lastProcessedCandleTimes, Date.now())) {
                // A stale/partial candle snapshot is NOT a completed check.
                candleCloseCheckPlanner.failed(key, fresh.config, Date.now());
              } else {
                candleCloseCheckPlanner.succeeded(key, fresh.config, Date.now());
              }
            } catch (coinErr) {
              candleCloseCheckPlanner.failed(key, coin.config, Date.now());
              console.error(`[CRON:surveillance] Error on ${coin.symbol}:`, coinErr);
            }
            if (Date.now() - lastPersistAt >= 5_000) {
              if (!flushDeferredSurveillanceChecks())
                console.error('[CRON:surveillance] Failed to flush deferred observations');
              lastPersistAt = Date.now();
            }
            // Keep the event loop responsive during a large backlog. The next
            // pass resumes at the next owner instead of starving later accounts.
            if (Date.now() - start >= 10_000) { examined++; break; }
          }
          this.surveillanceCursor = (first + examined) % count;
        } else {
          this.surveillanceCursor = 0;
        }

        job.lastRunAt = new Date().toISOString();
        job.lastDurationMs = Date.now() - start;
        job.runCount++;
        job.lastError = null;
      } catch (err: any) {
        job.errorCount++;
        job.lastError = err?.message || 'Помилка виконання нагляду';
        console.error('[CRON:surveillance] Error:', err);
      } finally {
        if (!flushDeferredSurveillanceChecks())
          console.error('[CRON:surveillance] Failed to flush final observations');
        job.isRunning = false;
      }
    };

    setTimeout(run, 3000);
    const timer = setInterval(run, job.intervalMs);
    this.timers.set(job.id, timer);
  }

  // --- 3. Screener Patterns Cron (Every 60s) ---
  private startScreenerCron() {
    const job = this.jobs.screener_patterns;
    if (this.timers.has(job.id)) clearInterval(this.timers.get(job.id)!);

    const run = async () => {
      if (job.isRunning || !job.enabled) return;
      job.isRunning = true;
      const start = Date.now();
      try {
        // One bounded worker prepares configured TFs within the same total budget.
        await runBackgroundFormationScans();

        job.lastRunAt = new Date().toISOString();
        job.lastDurationMs = Date.now() - start;
        job.runCount++;
        job.lastError = null;
      } catch (err: any) {
        job.errorCount++;
        job.lastError = err?.message || 'Помилка скринера патернів';
      } finally {
        job.isRunning = false;
      }
    };

    setTimeout(run, 10000);
    const timer = setInterval(run, job.intervalMs);
    this.timers.set(job.id, timer);
  }

  // --- Manual Run Trigger ---
  public async triggerJob(jobId: string): Promise<{ success: boolean; message: string; durationMs?: number }> {
    if (jobId === 'all') {
      const start = Date.now();
      await Promise.allSettled([
        checkAlertsOnce(),
        (async () => {
          const active = getAllActiveSurveillanceCoins();
          for (const { coin } of active.slice(0, 5)) {
            await checkCoinSurveillance(coin).catch(() => {});
          }
        })(),
      ]);
      return { success: true, message: 'Усі завдання cron успішно виконано вручну', durationMs: Date.now() - start };
    }

    if (jobId === 'price_alerts') {
      const start = Date.now();
      await checkAlertsOnce();
      this.jobs.price_alerts.lastRunAt = new Date().toISOString();
      return { success: true, message: 'Перевірку цінових алерів виконано', durationMs: Date.now() - start };
    }

    if (jobId === 'surveillance') {
      const start = Date.now();
      const active = getAllActiveSurveillanceCoins();
      for (const { coin } of active) {
        await checkCoinSurveillance(coin).catch(() => {});
      }
      this.jobs.surveillance.lastRunAt = new Date().toISOString();
      return { success: true, message: `Нагляд перевірено (${active.length} активних монет)`, durationMs: Date.now() - start };
    }

    return { success: false, message: `Невідоме завдання cron: ${jobId}` };
  }

  /**
   * Read-only operation timings. No user records, tokens, destinations, or
   * payloads are exposed through the operator-only capacity endpoint.
   */
  public getOperatorJobStats() {
    return Object.values(this.jobs).map(job => ({
      id: job.id,
      intervalMs: job.intervalMs,
      lastRunAt: job.lastRunAt,
      lastDurationMs: job.lastDurationMs,
      runCount: job.runCount,
      errorCount: job.errorCount,
      isRunning: job.isRunning,
      enabled: job.enabled,
    }));
  }

  // --- System Diagnostic Status ---
  public getStatus(userId?: string): CronSystemStatus {
    const allAlerts = userId ? getAllAlerts(userId) : loadAlerts();
    const activeAlerts = allAlerts.filter((a) => a.isActive && !a.triggered);
    const surveillanceCoins = getAllActiveSurveillanceCoins().filter(item => !userId || item.userId === userId);
    const tgConfig = getUserTelegram(userId);

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      startedAt: new Date(this.startTime).toISOString(),
      isHealthy: Object.values(this.jobs).every((j) => j.errorCount < 10),
      jobs: this.jobs,
      stats: {
        totalAlertsMonitored: allAlerts.length,
        activeAlertsCount: activeAlerts.length,
        surveillanceCoinsMonitored: surveillanceCoins.length,
        telegramConfigured: Boolean(tgConfig?.botToken && tgConfig?.chatId && tgConfig?.confirmedAt),
      },
    };
  }

  // --- Stop all cron jobs cleanly ---
  public stop() {
    for (const [id, timer] of this.timers.entries()) {
      clearInterval(timer);
    }
    this.timers.clear();
    console.log('[CRON] All cron background jobs stopped.');
  }
}

export const cronManager = new CronManager();
