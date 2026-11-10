import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import type { Database } from "./db";
import { fail } from "./security";
export function amount(value: unknown, nullable = false): string | null {
  if (nullable && (value === null || value === "" || value === undefined))
    return null;
  if (typeof value !== "string" && typeof value !== "number")
    fail("Некоректна сума");
  try {
    const d = new Decimal(value);
    if (!d.isFinite() || d.lte(0) || d.gt("1000000000000"))
      fail("Некоректна сума");
    return d.toFixed();
  } catch {
    fail("Некоректна сума");
  }
}
export function riskWindows(now: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    fail("Некоректна часова зона");
  }
  const p = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  function midnight(day: number) {
    let t = Date.UTC(p.year, p.month - 1, day);
    for (let i = 0; i < 5; i++) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(t));
      const n = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
      const delta =
        Date.UTC(p.year, p.month - 1, day) -
        Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second);
      t += delta;
      if (!delta) break;
    }
    return new Date(t);
  }
  return {
    hourly: { from: new Date(now.getTime() - 3600_000), key: "rolling-hour" },
    daily: { from: midnight(p.day), key: `day:${p.year}-${p.month}-${p.day}` },
    monthly: { from: midnight(1), key: `month:${p.year}-${p.month}` },
  };
}
export function lossSum(pnls: string[]): string {
  return pnls
    .reduce(
      (sum, p) => (new Decimal(p).lt(0) ? sum.minus(p) : sum),
      new Decimal(0),
    )
    .toFixed();
}
export async function evaluateRisk(
  db: Database,
  userId: string,
  now = new Date(),
) {
  const { rows } = await db.query(
    "SELECT * FROM hc_risk_policies WHERE owner_id=$1",
    [userId],
  );
  if (!rows.length) return null;
  const rule = rows[0],
    windows = riskWindows(now, rule.timezone),
    result: any = { rule, windows: {} };
  const connections = await db.query(
    "SELECT synced_at,covered_from,status FROM hc_connections WHERE owner_id=$1",
    [userId],
  );
  const unlinked = await db.query(
    `SELECT count(*)::integer AS count FROM hc_trades WHERE owner_id=$1 AND currency<>$2 AND closed_at>=$3`,
    [userId, rule.currency, windows.monthly.from],
  );
  for (const [name, window] of Object.entries(windows)) {
    const events = await db.query(
      "SELECT pnl FROM hc_trades WHERE owner_id=$1 AND currency=$2 AND closed_at>=$3 AND closed_at<=$4",
      [userId, rule.currency, window.from, now],
    );
    const used = lossSum(events.rows.map((r) => r.pnl));
    const fresh =
      connections.rows.length > 0 &&
      connections.rows.every(
        (c) =>
          c.status === "connected" &&
          c.synced_at &&
          now.getTime() - new Date(c.synced_at).getTime() >= 0 &&
          now.getTime() - new Date(c.synced_at).getTime() < 180_000 &&
          c.covered_from &&
          new Date(c.covered_from) <= window.from,
      );
    result.windows[name] = {
      used,
      limit: rule[name],
      from: window.from,
      complete: fresh && !unlinked.rows[0].count,
    };
    const breached = !!rule[name] && new Decimal(used).gte(rule[name]);
    await db.transaction(async (tx) => {
      const live = await tx.query(
        "SELECT id FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
        [userId],
      );
      if (!live.rows.length) return;
      const current = await tx.query(
        "SELECT version FROM hc_risk_policies WHERE owner_id=$1 AND version=$2",
        [userId, rule.version],
      );
      if (!current.rows.length) return;
      await tx.query(
        "INSERT INTO hc_risk_state(owner_id,policy_version,window_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [userId, rule.version, window.key],
      );
      const previous = await tx.query(
        "SELECT breached FROM hc_risk_state WHERE owner_id=$1 AND policy_version=$2 AND window_key=$3 FOR UPDATE",
        [userId, rule.version, window.key],
      );
      if (breached && !previous.rows[0].breached) {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO hc_notifications(id,owner_id,type,body,dedup_key) VALUES($1,$2,'risk',$3,$4) ON CONFLICT DO NOTHING`,
          [
            id,
            userId,
            {
              window: name,
              used,
              limit: rule[name],
              currency: rule.currency,
              asOf: now,
              complete: fresh && !unlinked.rows[0].count,
            },
            `risk:${userId}:${rule.version}:${window.key}:${id}`,
          ],
        );
      }
      await tx.query(
        "UPDATE hc_risk_state SET breached=$4 WHERE owner_id=$1 AND policy_version=$2 AND window_key=$3",
        [userId, rule.version, window.key, breached],
      );
    });
  }
  return result;
}
