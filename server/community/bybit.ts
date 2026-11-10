import { createHmac, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { Database } from "./db";
import { bounded, fail, seal, tokenHash, unseal } from "./security";
import { exchangeSlot } from "./history";
import { evaluateRisk } from "./risk";

const paths = new Set([
  "/v5/user/query-api",
  "/v5/position/closed-pnl",
  "/v5/position/list",
  "/v5/execution/list",
]);
type Credential = { key: string; secret: string };
/** Fixed mainnet host and GET allowlist. No trading, transfer, key-management or withdrawal implementation. */
export async function bybitRead(
  db: Database,
  credential: Credential,
  path: string,
  params: Record<string, string> = {},
) {
  if (!paths.has(path)) fail("Недозволена операція біржового конектора", 403);
  await exchangeSlot(db, "bybit");
  const query = new URLSearchParams(params).toString(),
    timestamp = String(Date.now()),
    window = "5000";
  const signature = createHmac("sha256", credential.secret)
    .update(timestamp + credential.key + window + query)
    .digest("hex");
  const response = await fetch(
    "https://api.bybit.com" + path + (query ? "?" + query : ""),
    {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "X-BAPI-API-KEY": credential.key,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": window,
        "X-BAPI-SIGN": signature,
      },
    },
  );
  if (!response.ok)
    fail(
      "Біржа відхилила читання. Перевірте доступність, права та IP-обмеження.",
      503,
    );
  const body = await response.json();
  if (body.retCode !== 0)
    fail(
      `Читання біржі недоступне (код ${Number(body.retCode) || "невідомий"})`,
      503,
    );
  return body.result;
}
export function checkReadOnly(info: any) {
  if (info?.readOnly !== 1 || !info?.userID)
    fail(
      "Потрібен окремий API-ключ Bybit тільки для читання. Торгові ключі не приймаються.",
      403,
    );
}
export async function connectBybit(db: Database, owner: string, input: any) {
  const key = bounded(input.key, 256),
    secret = bounded(input.secret, 256);
  if (key.length < 10 || secret.length < 10)
    fail("Перевірте API-ключ і секрет");
  const credential = { key, secret },
    info = await bybitRead(db, credential, "/v5/user/query-api");
  checkReadOnly(info);
  const accountHash = tokenHash("bybit:" + String(info.userID)),
    id = randomUUID();
  try {
    await db.transaction(async (tx) => {
      const live = await tx.query(
        "SELECT id FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
        [owner],
      );
      if (!live.rows.length) fail("Акаунт закрито", 401);
      await tx.query(
        `INSERT INTO hc_connections(id,owner_id,exchange,account_hash,credential) VALUES($1,$2,'bybit',$3,$4)`,
        [
          id,
          owner,
          accountHash,
          seal(JSON.stringify(credential), owner + ":" + id),
        ],
      );
    });
  } catch (error: any) {
    if (error.code === "23505")
      fail("Цей біржовий акаунт уже підключений", 409);
    throw error;
  }
  return id;
}
export async function syncBybit(db: Database, id: string, owner: string) {
  const claimed = await db.query(
    `UPDATE hc_connections SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND owner_id=$2 AND credential<>'' AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,
    [id, owner],
  );
  if (!claimed.rows.length)
    fail("Синхронізація вже триває або підключення недоступне", 409);
  const connection = claimed.rows[0],
    credential = JSON.parse(unseal(connection.credential, owner + ":" + id));
  const now = Date.now(),
    month = new Date(now);
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  const start = connection.synced_at
    ? Math.max(
        month.getTime() - 86400_000,
        new Date(connection.synced_at).getTime() - 7 * 86400_000,
      )
    : month.getTime() - 86400_000;
  let complete = true;
  try {
    checkReadOnly(await bybitRead(db, credential, "/v5/user/query-api"));
    for (let from = start; from <= now; from += 7 * 86400_000) {
      let cursor = "",
        pages = 0;
      do {
        const active = await db.query(
          `SELECT id FROM hc_connections WHERE id=$1 AND credential<>'' AND status<>'disconnected'`,
          [id],
        );
        if (!active.rows.length) fail("Підключення від’єднано", 409);
        const result = await bybitRead(
          db,
          credential,
          "/v5/position/closed-pnl",
          {
            category: "linear",
            startTime: String(from),
            endTime: String(Math.min(now, from + 7 * 86400_000 - 1)),
            limit: "100",
            ...(cursor ? { cursor } : {}),
          },
        );
        if (!Array.isArray(result.list)) fail("Некоректний журнал біржі", 503);
        await db.transaction(async (tx) => {
          const live = await tx.query(
            "SELECT id FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
            [owner],
          );
          if (!live.rows.length) fail("Акаунт закрито", 401);
          const linked = await tx.query(
            "SELECT id FROM hc_connections WHERE id=$1 AND owner_id=$2 AND credential<>'' FOR SHARE",
            [id, owner],
          );
          if (!linked.rows.length) fail("Підключення від’єднано", 409);
          for (const row of result.list) {
            if (
              !/^[\p{L}\p{M}\p{N}]{2,30}$/u.test(row.symbol) ||
              typeof row.orderId !== "string" ||
              !new Decimal(row.closedPnl).isFinite() ||
              !Number.isFinite(Number(row.updatedTime))
            )
              fail("Некоректні дані виконання", 503);
            // closedPnl is the exchange's closed-order result; do not subtract fees again.
            const currency = row.symbol.endsWith("USDT")
              ? "USDT"
              : row.symbol.endsWith("USDC")
                ? "USDC"
                : "UNSUPPORTED";
            await tx.query(
              `INSERT INTO hc_trades(connection_id,source_id,owner_id,symbol,currency,pnl,closed_at,source) SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE EXISTS(SELECT 1 FROM hc_connections WHERE id=$1 AND credential<>'')
            ON CONFLICT(connection_id,source_id) DO UPDATE SET pnl=excluded.pnl,source=excluded.source`,
              [
                id,
                row.orderId,
                owner,
                row.symbol,
                currency,
                row.closedPnl,
                new Date(Number(row.updatedTime)),
                row,
              ],
            );
          }
        });
        cursor = result.nextPageCursor ?? "";
        pages++;
        if (cursor && pages >= 10) {
          complete = false;
          break;
        }
      } while (cursor);
    }
    await db.query(
      `UPDATE hc_connections SET synced_at=$2,covered_from=CASE WHEN $3 THEN COALESCE(covered_from,$4) ELSE NULL END,status=$5,error_code=NULL,lease_until=NULL WHERE id=$1 AND credential<>''`,
      [
        id,
        new Date(now),
        complete,
        new Date(start),
        complete ? "connected" : "partial",
      ],
    );
    await evaluateRisk(db, owner, new Date(now));
  } catch (error: any) {
    await db.query(
      `UPDATE hc_connections SET status=CASE WHEN credential='' THEN 'disconnected' ELSE 'error' END,error_code=$2,lease_until=NULL WHERE id=$1`,
      [id, String(error.status ?? "sync_failed")],
    );
    throw error;
  }
}
