import type { Express, Request, Response } from "express";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { Database } from "./db";
import { accountFor, type Account } from "./account";
import { bounded, checkMutation, fail, RequestLimits, uuid } from "./security";
import {
  policy,
  createItem,
  editItem,
  getChart,
  presentItem,
  saveChart,
  type Item,
  type Policy,
} from "./content";
import { historyBlock } from "./history";
import { TF_SECONDS } from "../../src/community/chartDocument";
import { amount, evaluateRisk } from "./risk";
import { connectBybit, syncBybit } from "./bybit";
import { publicProfileUrl } from "./profileNames";

export function installCommunityRoutes(app: Express, getDb: () => Database) {
  const limits = new RequestLimits();
  const route = (
    method: "get" | "post" | "patch" | "delete",
    url: string,
    run: (
      req: Request,
      res: Response,
      db: Database,
      a: Account,
      p: Policy,
    ) => Promise<void>,
    max = 100,
  ) => {
    app[method]("/api/community" + url, async (req, res) => {
      res.set("Cache-Control", "private, no-store");
      res.set("X-Content-Type-Options", "nosniff");
      try {
        checkMutation(req);
        const db = getDb(),
          a = await accountFor(db, req);
        if (!a) fail("Увійдіть у свій акаунт", 401);
        limits.take(a.id + ":" + method + ":" + url, max);
        if (
          method === "get" ||
          (method === "post" &&
            (url === "/connections" || url === "/connections/:id/sync"))
        )
          await run(req, res, db, a, await policy(db, a.id));
        else {
          let status = 200,
            body: unknown;
          const deferred = {
            status(code: number) {
              status = code;
              return deferred;
            },
            json(value: unknown) {
              body = value;
              return deferred;
            },
          } as unknown as Response;
          await db.transaction(async (tx) => {
            const live = await tx.query(
              "SELECT id FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
              [a.id],
            );
            if (!live.rows.length) fail("Сеанс акаунта закінчився", 401);
            await run(req, deferred, tx, a, await policy(tx, a.id));
          });
          res.status(status).json(body);
        }
      } catch (error: any) {
        res.status(error.status ?? 503).json({
          success: false,
          error: error.status
            ? error.message
            : "Community тимчасово недоступне",
        });
      }
    });
  };
  route("get", "/feed", async (req, res, db, _a, p) => {
    const mode = req.query.owner
        ? "wall"
        : req.query.mode === "friends"
          ? "friends"
          : "public",
      wallOwner = req.query.owner ? uuid(req.query.owner) : null,
      before = req.query.before ? uuid(req.query.before) : null;
    const { rows } = await db.query<Item>(
      `SELECT * FROM hc_items WHERE kind='post' AND NOT deleted
      AND ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM hc_items WHERE id=$1))
      AND ($2<>'public' OR audience='public') AND ($3::uuid IS NULL OR owner_id=$3) ORDER BY created_at DESC,id DESC LIMIT 40`,
      [before, mode, wallOwner],
    );
    const output = [];
    for (const row of rows) {
      if (
        mode === "friends" &&
        !p.accepted.has(row.owner_id) &&
        row.owner_id !== p.viewer
      )
        continue;
      const item = await presentItem(db, p, row);
      if (item) output.push(item);
    }
    res.json({
      success: true,
      items: output,
      next: rows.length === 40 ? rows.at(-1)!.id : null,
    });
  });
  route("get", "/items", async (req, res, db, a, p) => {
    const kind = bounded(req.query.kind ?? "strategy", 20);
    if (!["strategy", "plan", "lesson", "test"].includes(kind))
      fail("Некоректний розділ");
    const { rows } = await db.query<Item>(
      `SELECT * FROM hc_items WHERE kind=$1 AND NOT deleted AND ($2::boolean=false OR owner_id=$3) ORDER BY created_at DESC LIMIT 100`,
      [kind, req.query.mine === "1", a.id],
    );
    const output = [];
    for (const row of rows) {
      const item = await presentItem(db, p, row);
      if (item) output.push(item);
    }
    res.json({ success: true, items: output });
  });
  route("get", "/items/:id", async (req, res, db, _a, p) => {
    const row = await p.item(uuid(req.params.id));
    const item = row ? await presentItem(db, p, row) : null;
    if (!item) fail("Матеріал недоступний", 404);
    res.json({ success: true, item });
  });
  route("get", "/items/:id/comments", async (req, res, db, _a, p) => {
    const id = uuid(req.params.id),
      parent = await p.item(id);
    if (
      !(await p.visible(parent)) ||
      (parent?.chart_id && !(await p.canReadChart(parent.chart_id)))
    )
      fail("Матеріал недоступний", 404);
    const after = req.query.after ? uuid(req.query.after) : null;
    const { rows } = await db.query<Item>(
      `SELECT * FROM hc_items WHERE parent_id=$1 AND kind='comment' AND NOT deleted
      AND ($2::uuid IS NULL OR (created_at,id)>(SELECT created_at,id FROM hc_items WHERE id=$2 AND parent_id=$1))
      ORDER BY created_at,id LIMIT 40`,
      [id, after],
    );
    const items = [];
    for (const row of rows) {
      const item = await presentItem(db, p, row);
      if (item) items.push(item);
    }
    res.json({
      success: true,
      items,
      next: rows.length === 40 ? rows.at(-1)!.id : null,
    });
  });
  route(
    "post",
    "/items",
    async (req, res, db, a, p) => {
      limits.take("publish:" + a.id, 20);
      const id = await createItem(db, p, req.body);
      res.status(201).json({ success: true, id });
    },
    30,
  );
  route(
    "patch",
    "/items/:id",
    async (req, res, db, _a, p) => {
      await editItem(db, p, req.params.id, req.body);
      res.json({ success: true });
    },
    30,
  );
  route("delete", "/items/:id", async (req, res, db, a, p) => {
    const id = uuid(req.params.id),
      row = await p.item(id);
    if (!row || row.owner_id !== a.id) fail("Матеріал недоступний", 404);
    await db.transaction(async (tx) => {
      await tx.query(
        "UPDATE hc_items SET deleted=true,updated_at=now() WHERE id=$1",
        [id],
      );
      await tx.query(
        "UPDATE hc_reputation SET points=0 WHERE owner_id=$1 AND event_key=$2",
        [a.id, row.kind + ":" + id],
      );
    });
    res.json({ success: true });
  });
  route("post", "/items/:id/reaction", async (req, res, db, a, p) => {
    const id = uuid(req.params.id);
    if (!(await p.visible(await p.item(id)))) fail("Матеріал недоступний", 404);
    const emoji = bounded(req.body.emoji, 10);
    if (!["👍", "❤️", "🔥", "🤔", "👏"].includes(emoji))
      fail("Непідтримувана реакція");
    await db.query(
      "INSERT INTO hc_reactions(item_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT(item_id,user_id) DO UPDATE SET emoji=excluded.emoji",
      [id, a.id, emoji],
    );
    res.json({ success: true });
  });
  route(
    "post",
    "/charts",
    async (req, res, db, _a, p) => {
      const id = await saveChart(db, p, req.body.document, req.body.parentId);
      res.status(201).json({ success: true, id });
    },
    30,
  );
  route("get", "/charts/:id", async (req, res, db, _a, p) => {
    res.set("Cache-Control", "private, no-store");
    res.json({
      success: true,
      document: await getChart(db, p, uuid(req.params.id)),
    });
  });
  route(
    "get",
    "/charts/:id/history",
    async (req, res, db, _a, p) => {
      const document = await getChart(db, p, uuid(req.params.id));
      const timeframe = String(req.query.timeframe) as keyof typeof TF_SECONDS,
        before = Math.min(Number(req.query.before), document.cutoff);
      const rows = await historyBlock(db, {
        symbol: document.symbol,
        exchange: document.exchange,
        marketType: document.marketType,
        timeframe,
        before,
      });
      // Never reconstruct an unfinished historical bar using prices from after the snapshot.
      res.json({
        success: true,
        rows: rows.filter(
          (row) => row.time + TF_SECONDS[timeframe] <= document.cutoff,
        ),
      });
    },
    30,
  );
  route(
    "get",
    "/history",
    async (req, res, db, a) => {
      const symbol = String(req.query.symbol),
        exchange = String(req.query.exchange) as "binance" | "bybit",
        marketType = String(req.query.marketType) as "spot" | "futures";
      const timeframe = String(req.query.timeframe) as keyof typeof TF_SECONDS,
        before = Math.min(
          Number(req.query.before) || Date.now() / 1000,
          Date.now() / 1000,
        );
      // The seed endpoint is explicit, bounded and user initiated. Nothing calls it while rendering cards.
      res.json({
        success: true,
        rows: await historyBlock(db, {
          symbol,
          exchange,
          marketType,
          timeframe,
          before,
        }),
      });
    },
    12,
  );
  route("get", "/archives", async (_req, res, db, a, p) => {
    const { rows } = await db.query(
      `SELECT body-'chartDocument' AS body,body ? 'chartDocument' AS has_chart FROM hc_archives WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 1000`,
      [a.id],
    );
    const items = [];
    for (const row of rows)
      if (
        !row.body.sourceChartId ||
        (await p.canReadChart(row.body.sourceChartId))
      )
        items.push({ ...row.body, hasChartDocument: row.has_chart });
    res.json({
      success: true,
      items,
    });
  });
  route("get", "/archives/:id", async (req, res, db, a, p) => {
    const { rows } = await db.query(
      "SELECT body FROM hc_archives WHERE owner_id=$1 AND id=$2",
      [a.id, bounded(req.params.id, 150)],
    );
    if (!rows.length) fail("Збереження недоступне", 404);
    if (
      rows[0].body.sourceChartId &&
      !(await p.canReadChart(rows[0].body.sourceChartId))
    )
      fail("Джерело збереження недоступне", 404);
    res.set("Cache-Control", "private, no-store");
    res.json({ success: true, item: rows[0].body });
  });
  route(
    "post",
    "/archives",
    async (req, res, db, a, p) => {
      const body = { ...req.body, userId: a.id },
        id = bounded(body.id, 150);
      if (!/^arch_[\p{L}\p{M}\p{N}_-]+$/u.test(id)) fail("Некоректна формація");
      if (JSON.stringify(body).length > 600_000) fail("Знімок завеликий");
      if (
        body.sourceChartId &&
        !(await p.canReadChart(uuid(body.sourceChartId)))
      )
        fail("Джерело збереження недоступне", 404);
      const previous = await db.query(
        "SELECT body->>'sourceChartId' AS source FROM hc_archives WHERE owner_id=$1 AND id=$2",
        [a.id, id],
      );
      if (
        previous.rows[0]?.source &&
        previous.rows[0].source !== body.sourceChartId
      )
        fail("Не можна прибрати зв’язок із джерелом", 403);
      if (body.chartDocument) {
        const { normalizeChartDocument } =
          await import("../../src/community/chartDocument");
        body.chartDocument = normalizeChartDocument(body.chartDocument);
      }
      await db.query(
        "INSERT INTO hc_archives(id,owner_id,body) VALUES($1,$2,$3) ON CONFLICT(owner_id,id) DO UPDATE SET body=excluded.body",
        [id, a.id, body],
      );
      res.json({ success: true, item: body });
    },
    30,
  );
  route("delete", "/archives/:id", async (req, res, db, a) => {
    await db.query("DELETE FROM hc_archives WHERE owner_id=$1 AND id=$2", [
      a.id,
      bounded(req.params.id, 150),
    ]);
    res.json({ success: true });
  });
  route("delete", "/archives", async (_req, res, db, a) => {
    await db.query("DELETE FROM hc_archives WHERE owner_id=$1", [a.id]);
    res.json({ success: true });
  });
  route(
    "get",
    "/people",
    async (req, res, db, a, p) => {
      const q = bounded(req.query.q ?? "", 80);
      if (q.length < 2) {
        res.json({ success: true, people: [] });
        return;
      }
      const { rows } = await db.query(
        `SELECT id,profile FROM hc_users WHERE id<>$1 AND deleted_at IS NULL AND profile->>'displayName' ILIKE $2 ESCAPE '\\' LIMIT 30`,
        [a.id, "%" + q.replace(/[\\%_]/g, "\\$&") + "%"],
      );
      res.json({
        success: true,
        people: rows
          .filter((r) => !p.blocked.has(r.id))
          .map((r) => ({
            id: r.id,
            displayName: r.profile.displayName ?? "Трейдер",
            friend: p.accepted.has(r.id),
          })),
      });
    },
    30,
  );
  route("get", "/friends", async (_req, res, db, a, p) => {
    const { rows } = await db.query(
      `SELECT f.*,u.id,u.profile FROM hc_friendships f JOIN hc_users u ON u.id=CASE WHEN f.sender=$1 THEN f.recipient ELSE f.sender END WHERE f.sender=$1 OR f.recipient=$1`,
      [a.id],
    );
    res.json({
      success: true,
      people: rows
        .filter((r) => !p.blocked.has(r.id))
        .map((r) => ({
          id: r.id,
          displayName: r.profile.displayName ?? "Трейдер",
          accepted: r.accepted,
          incoming: r.recipient === a.id,
        })),
    });
  });
  route(
    "post",
    "/friends/:id",
    async (req, res, db, a, p) => {
      const id = uuid(req.params.id);
      if (id === a.id || p.blocked.has(id)) fail("Контакт недоступний", 403);
      const other = await db.query(
        "SELECT id FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
        [id],
      );
      if (!other.rows.length) fail("Контакт недоступний", 404);
      const incoming = await db.query(
        "UPDATE hc_friendships SET accepted=true WHERE sender=$1 AND recipient=$2 RETURNING sender",
        [id, a.id],
      );
      if (!incoming.rows.length)
        await db.query(
          "INSERT INTO hc_friendships(sender,recipient) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [a.id, id],
        );
      res.json({ success: true });
    },
    10,
  );
  route("delete", "/friends/:id", async (req, res, db, a) => {
    await db.query(
      "DELETE FROM hc_friendships WHERE (sender=$1 AND recipient=$2) OR(sender=$2 AND recipient=$1)",
      [a.id, uuid(req.params.id)],
    );
    res.json({ success: true });
  });
  route("post", "/blocks/:id", async (req, res, db, a) => {
    const id = uuid(req.params.id);
    if (id === a.id) fail("Некоректний контакт");
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO hc_blocks(owner_id,target_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [a.id, id],
      );
      await tx.query(
        "DELETE FROM hc_friendships WHERE (sender=$1 AND recipient=$2) OR(sender=$2 AND recipient=$1)",
        [a.id, id],
      );
    });
    res.json({ success: true });
  });
  route("get", "/profiles/:id", async (req, res, db, a, p) => {
    const id = uuid(req.params.id);
    if (p.blocked.has(id)) fail("Профіль недоступний", 404);
    const { rows } = await db.query(
      "SELECT u.profile,u.created_at,n.username FROM hc_users u LEFT JOIN hc_profile_names n ON n.owner_id=u.id WHERE u.id=$1 AND u.deleted_at IS NULL",
      [id],
    );
    if (!rows.length) fail("Профіль недоступний", 404);
    const profile = rows[0].profile,
      canShare = (audience: string) =>
        id === a.id ||
        audience === "public" ||
        (audience === "friends" && p.accepted.has(id));
    const score = await db.query(
      "SELECT COALESCE(sum(points),0)::integer AS points FROM hc_reputation WHERE owner_id=$1",
      [id],
    );
    const status = profile.community?.status;
    const validStatus =
      status &&
      (!status.expiresAt || Date.parse(status.expiresAt) > Date.now()) &&
      canShare(status.audience ?? "private");
    res.json({
      success: true,
      profile: {
        id,
        displayName: profile.displayName ?? "Трейдер",
        joinedAt: rows[0].created_at,
        publicUrl: profile.community?.publicProfileEnabled === true && rows[0].username ? publicProfileUrl(rows[0].username) : null,
        points: score.rows[0].points,
        bio: canShare(profile.community?.bioAudience ?? "public")
          ? profile.community?.bio
          : "",
        interests: canShare(profile.community?.interestsAudience ?? "private")
          ? profile.community?.interests
          : "",
        lifestyle: canShare(profile.community?.lifestyleAudience ?? "private")
          ? profile.community?.lifestyle
          : "",
        telegram: canShare(profile.community?.telegramAudience ?? "private")
          ? profile.community?.telegram
          : "",
        status: validStatus ? status : null,
      },
    });
  });
  route("get", "/conversations", async (_req, res, db, a) => {
    const { rows } = await db.query(
      "SELECT c.*,m.role FROM hc_conversations c JOIN hc_members m ON m.conversation_id=c.id WHERE m.user_id=$1 ORDER BY c.created_at DESC LIMIT 100",
      [a.id],
    );
    res.json({ success: true, items: rows });
  });
  route(
    "post",
    "/conversations",
    async (req, res, db, a, p) => {
      const members = [...new Set<string>((req.body.members ?? []).map(uuid))];
      if (members.length > 30 || !members.length)
        fail("Оберіть від 1 до 30 друзів");
      for (const id of members)
        if (!p.accepted.has(id) || p.blocked.has(id))
          fail("Запрошувати можна лише друзів, що прийняли запит", 403);
      const living = await db.query(
        "SELECT id FROM hc_users WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL FOR SHARE",
        [members],
      );
      if (living.rows.length !== members.length)
        fail("Один із контактів уже недоступний", 404);
      const id = randomUUID(),
        title = bounded(req.body.title ?? "Розмова", 100);
      await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO hc_conversations(id,owner_id,title,is_group) VALUES($1,$2,$3,$4)",
          [id, a.id, title, members.length > 1],
        );
        await tx.query(
          `INSERT INTO hc_members(conversation_id,user_id,role) VALUES($1,$2,'owner')`,
          [id, a.id],
        );
        for (const userId of members)
          await tx.query(
            "INSERT INTO hc_members(conversation_id,user_id) VALUES($1,$2)",
            [id, userId],
          );
      });
      res.status(201).json({ success: true, id });
    },
    6,
  );
  route("get", "/conversations/:id/messages", async (req, res, db, _a, p) => {
    const id = uuid(req.params.id),
      member = p.member.get(id);
    if (!member) fail("Розмова недоступна", 404);
    const before = req.query.before ? uuid(req.query.before) : null;
    const after = req.query.after ? uuid(req.query.after) : null;
    const { rows } = await db.query<Item>(
      after
        ? `SELECT * FROM hc_items WHERE conversation_id=$1 AND NOT deleted AND created_at>=$2
      AND (created_at,id)>(SELECT created_at,id FROM hc_items WHERE id=$3 AND conversation_id=$1) ORDER BY created_at ASC,id ASC LIMIT 40`
        : `SELECT * FROM hc_items WHERE conversation_id=$1 AND NOT deleted AND created_at>=$2
      AND ($3::uuid IS NULL OR(created_at,id)<(SELECT created_at,id FROM hc_items WHERE id=$3 AND conversation_id=$1)) ORDER BY created_at DESC,id DESC LIMIT 40`,
      [id, member.joined_at, after ?? before],
    );
    const items = [];
    for (const row of rows) {
      const item = await presentItem(db, p, row);
      if (item) items.push(item);
    }
    res.json({
      success: true,
      items: after ? items : items.reverse(),
      next: !after && rows.length === 40 ? rows.at(-1)!.id : null,
      incremental: Boolean(after),
    });
  });
  route(
    "post",
    "/conversations/:id/members",
    async (req, res, db, _a, p) => {
      const id = uuid(req.params.id),
        member = p.member.get(id),
        target = uuid(req.body.id);
      if (
        !member ||
        !["owner", "admin"].includes(member.role) ||
        !p.accepted.has(target) ||
        p.blocked.has(target)
      )
        fail("Запрошення недоступне", 403);
      const count = await db.query(
        "SELECT count(*)::integer AS count FROM hc_members WHERE conversation_id=$1",
        [id],
      );
      if (count.rows[0].count >= 31)
        fail("У групі вже максимальна кількість учасників");
      await db.query(
        "INSERT INTO hc_members(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [id, target],
      );
      res.json({ success: true });
    },
    10,
  );
  route(
    "delete",
    "/conversations/:id/members/:user",
    async (req, res, db, a, p) => {
      const id = uuid(req.params.id),
        target = uuid(req.params.user),
        member = p.member.get(id);
      if (!member) fail("Розмова недоступна", 404);
      if (target !== a.id && !["owner", "admin"].includes(member.role))
        fail("Недостатньо прав", 403);
      const current = await db.query(
        "SELECT role FROM hc_members WHERE conversation_id=$1 AND user_id=$2",
        [id, target],
      );
      if (current.rows[0]?.role === "owner")
        fail("Власник має спочатку передати групу");
      await db.query(
        "DELETE FROM hc_members WHERE conversation_id=$1 AND user_id=$2",
        [id, target],
      );
      res.json({ success: true });
    },
  );
  route("get", "/notifications", async (_req, res, db, a) => {
    const { rows } = await db.query(
      "SELECT * FROM hc_notifications WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 50",
      [a.id],
    );
    res.json({ success: true, items: rows });
  });
  route("post", "/notifications/:id/read", async (req, res, db, a) => {
    await db.query(
      "UPDATE hc_notifications SET read_at=now() WHERE id=$1 AND owner_id=$2",
      [uuid(req.params.id), a.id],
    );
    res.json({ success: true });
  });
  route("get", "/rankings", async (req, res, db) => {
    const currency = req.query.currency === "USDC" ? "USDC" : "USDT";
    const { rows } = await db.query(
      `SELECT u.id,u.profile->>'displayName' AS name,
      count(*) FILTER(WHERE t.pnl>0)::integer AS wins,count(*) FILTER(WHERE t.pnl<0)::integer AS losses,
      count(*) FILTER(WHERE t.pnl=0)::integer AS flat,count(*)::integer AS count
      FROM hc_users u JOIN hc_trades t ON t.owner_id=u.id WHERE u.profile->'community'->>'rankingPublic'='true'
      AND t.currency=$1 AND t.closed_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND NOT EXISTS(SELECT 1 FROM hc_connections c WHERE c.owner_id=u.id AND
        (c.status<>'connected' OR c.synced_at IS NULL OR c.synced_at<now()-interval '3 minutes' OR c.covered_from IS NULL OR c.covered_from>date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
      GROUP BY u.id HAVING count(*)>=30 ORDER BY (count(*) FILTER(WHERE t.pnl>0))::numeric/NULLIF(count(*) FILTER(WHERE t.pnl<>0),0) DESC NULLS LAST LIMIT 100`,
      [currency],
    );
    res.json({
      success: true,
      currency,
      period: "Поточний місяць UTC",
      method:
        "Win rate закритих ордерів Bybit, мінімум 30 закриттів; не рейтинг дохідності рахунку",
      items: rows.map((r) => ({
        ...r,
        winRate:
          r.wins + r.losses ? (r.wins / (r.wins + r.losses)) * 100 : null,
      })),
    });
  });
  route("get", "/moderation/reports", async (_req, res, db, a) => {
    if (!(process.env.COMMUNITY_MODERATOR_IDS ?? "").split(",").includes(a.id))
      fail("Недостатньо прав", 403);
    const { rows } = await db.query(
      `SELECT id,item_id,target_id,reason,status,created_at FROM hc_reports ORDER BY created_at DESC LIMIT 100`,
    );
    res.json({ success: true, items: rows });
  });
  route(
    "post",
    "/moderation/reports/:id",
    async (req, res, db, a) => {
      if (
        !(process.env.COMMUNITY_MODERATOR_IDS ?? "")
          .split(",")
          .includes(a.id) ||
        !a.strong
      )
        fail("Потрібен підтверджений доступ модератора", 403);
      const id = uuid(req.params.id),
        resolution = bounded(req.body.resolution, 2000);
      if (!resolution) fail("Укажіть підставу рішення");
      await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          "SELECT * FROM hc_reports WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (!rows.length) fail("Скаргу не знайдено", 404);
        await tx.query(
          `UPDATE hc_reports SET status='resolved',resolution=$2 WHERE id=$1`,
          [id, resolution],
        );
        if (req.body.remove === true && rows[0].item_id)
          await tx.query(
            "UPDATE hc_items SET deleted=true,updated_at=now() WHERE id=$1",
            [rows[0].item_id],
          );
        await tx.query(
          "INSERT INTO hc_audit(id,actor_id,action,target,details) VALUES($1,$2,$3,$4,$5)",
          [
            randomUUID(),
            a.id,
            "moderation-decision",
            id,
            { resolution, remove: req.body.remove === true },
          ],
        );
      });
      res.json({ success: true });
    },
    20,
  );
  route(
    "post",
    "/reports",
    async (req, res, db, a, p) => {
      const itemId = req.body.itemId ? uuid(req.body.itemId) : null,
        targetId = req.body.targetId ? uuid(req.body.targetId) : null;
      if (!itemId && !targetId) fail("Виберіть об’єкт скарги");
      if (itemId && !(await p.visible(await p.item(itemId))))
        fail("Матеріал недоступний", 404);
      await db.query(
        "INSERT INTO hc_reports(id,reporter_id,item_id,target_id,reason) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), a.id, itemId, targetId, bounded(req.body.reason, 2000)],
      );
      res.json({ success: true });
    },
    6,
  );
  route("get", "/risk", async (_req, res, db, a) => {
    res.json({ success: true, risk: await evaluateRisk(db, a.id) });
  });
  route(
    "post",
    "/risk",
    async (req, res, db, a) => {
      const timezone = bounded(req.body.timezone ?? "UTC", 100);
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone });
      } catch {
        fail("Некоректна часова зона");
      }
      const currency = bounded(req.body.currency ?? "USDT", 10);
      if (!["USDT", "USDC"].includes(currency))
        fail("Оберіть валюту без непідтвердженої конвертації");
      await db.query(
        `INSERT INTO hc_risk_policies(owner_id,timezone,currency,hourly,daily,monthly) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(owner_id) DO UPDATE SET version=hc_risk_policies.version+1,timezone=excluded.timezone,currency=excluded.currency,hourly=excluded.hourly,daily=excluded.daily,monthly=excluded.monthly,updated_at=now()`,
        [
          a.id,
          timezone,
          currency,
          amount(req.body.hourly, true),
          amount(req.body.daily, true),
          amount(req.body.monthly, true),
        ],
      );
      await db.query(
        "INSERT INTO hc_audit(id,actor_id,action,target,details) VALUES($1,$2,$3,$2,$4)",
        [randomUUID(), a.id, "risk-policy-changed", { timezone, currency }],
      );
      res.json({ success: true, risk: await evaluateRisk(db, a.id) });
    },
    12,
  );
  route("get", "/connections", async (_req, res, db, a) => {
    const { rows } = await db.query(
      "SELECT id,exchange,status,synced_at,covered_from,error_code FROM hc_connections WHERE owner_id=$1",
      [a.id],
    );
    res.json({ success: true, items: rows });
  });
  route(
    "post",
    "/connections",
    async (req, res, db, a) => {
      if (!a.email_verified || !a.mfa_secret || !a.strong)
        fail(
          "Підтвердіть email і двофакторний вхід перед підключенням ключа",
          403,
        );
      const id = await connectBybit(db, a.id, req.body);
      res.status(201).json({ success: true, id });
    },
    3,
  );
  route(
    "post",
    "/connections/:id/sync",
    async (req, res, db, a) => {
      await syncBybit(db, uuid(req.params.id), a.id);
      res.json({ success: true });
    },
    3,
  );
  route("delete", "/connections/:id", async (req, res, db, a) => {
    if (!a.strong) fail("Підтвердіть другий фактор", 403);
    await db.query(
      `UPDATE hc_connections SET credential='',status='disconnected',lease_until=NULL WHERE id=$1 AND owner_id=$2`,
      [uuid(req.params.id), a.id],
    );
    res.json({ success: true });
  });
  route("get", "/trades", async (req, res, db, a, p) => {
    const owner = req.query.owner ? uuid(req.query.owner) : a.id;
    if (p.blocked.has(owner)) fail("Статистика недоступна", 404);
    const ownerRow = await db.query(
      "SELECT profile FROM hc_users WHERE id=$1",
      [owner],
    );
    if (!ownerRow.rows.length) fail("Статистика недоступна", 404);
    const privacy = ownerRow.rows[0].profile.community ?? {},
      mine = owner === a.id;
    const allowed = (mode: string) =>
      mine ||
      mode === "public" ||
      (mode === "friends" && p.accepted.has(owner));
    if (!allowed(privacy.statisticsAudience ?? "private"))
      fail("Власник приховав статистику", 403);
    let cursor: any = null;
    if (req.query.before) {
      try {
        cursor = JSON.parse(
          Buffer.from(String(req.query.before), "base64url").toString(),
        );
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 3 ||
          !Number.isFinite(Date.parse(cursor[0]))
        )
          fail("Некоректний курсор");
        uuid(cursor[1]);
        bounded(cursor[2], 150);
      } catch {
        fail("Некоректний курсор");
      }
    }
    const { rows } = await db.query(
      `SELECT t.*,n.body AS notes,n.written_at FROM hc_trades t LEFT JOIN hc_trade_notes n ON n.connection_id=t.connection_id AND n.source_id=t.source_id
      WHERE t.owner_id=$1 AND ($2::timestamptz IS NULL OR(t.closed_at,t.connection_id,t.source_id)<($2::timestamptz,$3::uuid,$4::text))
      ORDER BY t.closed_at DESC,t.connection_id DESC,t.source_id DESC LIMIT 201`,
      [owner, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null],
    );
    const totals = await db.query(
      `SELECT currency,sum(pnl)::text AS pnl,count(*)::integer AS count,
      count(*) FILTER(WHERE pnl>0)::integer AS wins,count(*) FILTER(WHERE pnl<0)::integer AS losses,count(*) FILTER(WHERE pnl=0)::integer AS flat
      FROM hc_trades WHERE owner_id=$1 GROUP BY currency`,
      [owner],
    );
    const sums: Record<string, any> = {};
    for (const row of totals.rows) {
      sums[row.currency] = {
        ...row,
        winRate:
          row.wins + row.losses
            ? (row.wins / (row.wins + row.losses)) * 100
            : null,
      };
      if (!allowed(privacy.amountsAudience ?? "private"))
        delete sums[row.currency].pnl;
    }
    const showRows = allowed(privacy.tradesAudience ?? "private"),
      showAmounts = allowed(privacy.amountsAudience ?? "private"),
      showNotes = allowed(privacy.notesAudience ?? "private");
    const coverage = await db.query(
      "SELECT status,synced_at,covered_from FROM hc_connections WHERE owner_id=$1",
      [owner],
    );
    const page = rows.slice(0, 200),
      last = page.at(-1),
      next =
        showRows && rows.length > 200
          ? Buffer.from(
              JSON.stringify([
                last.closed_at,
                last.connection_id,
                last.source_id,
              ]),
            ).toString("base64url")
          : null;
    res.json({
      success: true,
      source: "bybit-mainnet-closed-orders",
      method:
        "win rate закритих ордерів, не повних позицій; дохідність рахунку не обчислюється",
      coverage: coverage.rows,
      summary: sums,
      next,
      items: showRows
        ? page.map((t) => ({
            connection_id: mine ? t.connection_id : undefined,
            source_id: mine ? t.source_id : undefined,
            symbol: t.symbol,
            currency: t.currency,
            closed_at: t.closed_at,
            pnl: showAmounts ? t.pnl : undefined,
            entry: t.source.avgEntryPrice,
            exit: t.source.avgExitPrice,
            qty: showAmounts ? t.source.qty : undefined,
            side: t.source.side,
            notes: showNotes ? t.notes : undefined,
            written_at: showNotes ? t.written_at : undefined,
          }))
        : [],
    });
  });
  route(
    "post",
    "/trades/notes",
    async (req, res, db, a) => {
      const id = uuid(req.body.connectionId),
        source = bounded(req.body.sourceId, 150),
        body = {
          reason: bounded(req.body.reason ?? "", 5000),
          review: bounded(req.body.review ?? "", 5000),
        };
      const trade = await db.query(
        "SELECT source_id FROM hc_trades WHERE connection_id=$1 AND source_id=$2 AND owner_id=$3",
        [id, source, a.id],
      );
      if (!trade.rows.length) fail("Угода недоступна", 404);
      await db.query(
        "INSERT INTO hc_trade_notes(connection_id,source_id,owner_id,body) VALUES($1,$2,$3,$4) ON CONFLICT(connection_id,source_id) DO UPDATE SET body=excluded.body,written_at=now()",
        [id, source, a.id, body],
      );
      res.json({ success: true });
    },
    30,
  );
}

/** Image bytes have a separate parser; originals/EXIF are never served. */
export function installMediaRoutes(app: Express, getDb: () => Database) {
  const root = () =>
    process.env.COMMUNITY_MEDIA_DIR ??
    path.resolve("server/data/community-media");
  const limits = new RequestLimits();
  let active = 0;
  app.post(
    "/api/community/media",
    express.raw({
      type: ["image/jpeg", "image/png", "image/webp"],
      limit: "5mb",
    }),
    async (req, res) => {
      let ownsSlot = false;
      let writtenFile: string | undefined;
      try {
        checkMutation(req);
        const db = getDb(),
          a = await accountFor(db, req);
        if (!a) fail("Увійдіть у свій акаунт", 401);
        limits.take(a.id, 8);
        if (!Buffer.isBuffer(req.body) || !req.body.length)
          fail("Потрібне фото JPEG, PNG або WebP");
        const quota = await db.query(
          "SELECT COALESCE(sum(bytes),0)::text AS used,count(*)::integer AS count FROM hc_media WHERE owner_id=$1",
          [a.id],
        );
        if (
          Number(quota.rows[0].used) >= 200 * 1024 * 1024 ||
          quota.rows[0].count >= 2000
        )
          fail("Досягнуто ліміт зображень цього акаунта", 413);
        if (active >= 2) fail("Обробка фото тимчасово зайнята", 503);
        active++;
        ownsSlot = true;
        const image = await sharp(req.body, { limitInputPixels: 16_000_000 })
          .rotate()
          .resize({
            width: 1800,
            height: 1800,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toBuffer();
        const id = randomUUID();
        await fs.mkdir(root(), { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(root(), id + ".webp"), image, {
          mode: 0o600,
          flag: "wx",
        });
        writtenFile = path.join(root(), id + ".webp");
        await db.transaction(async (tx) => {
          const live = await tx.query(
            "SELECT id FROM hc_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
            [a.id],
          );
          if (!live.rows.length) fail("Акаунт закрито", 401);
          const current = await tx.query(
            "SELECT COALESCE(sum(bytes),0)::text AS used,count(*)::integer AS count FROM hc_media WHERE owner_id=$1",
            [a.id],
          );
          if (
            Number(current.rows[0].used) + image.length > 200 * 1024 * 1024 ||
            current.rows[0].count >= 2000
          )
            fail("Досягнуто ліміт зображень", 413);
          await tx.query(
            "INSERT INTO hc_media(id,owner_id,bytes) VALUES($1,$2,$3)",
            [id, a.id, image.length],
          );
        });
        writtenFile = undefined;
        res.status(201).json({ success: true, id });
      } catch (error: any) {
        if (writtenFile)
          await fs.rm(writtenFile, { force: true }).catch(() => {});
        res.status(error.status ?? 400).json({
          success: false,
          error: error.status ? error.message : "Не вдалося обробити фото",
        });
      } finally {
        if (ownsSlot) active--;
      }
    },
  );
  app.get("/api/community/media/:id", async (req, res) => {
    try {
      const db = getDb(),
        a = await accountFor(db, req);
      if (!a) fail("Недоступно", 404);
      const id = uuid(req.params.id),
        rules = await policy(db, a.id);
      const asset = await db.query(
        "SELECT owner_id FROM hc_media WHERE id=$1",
        [id],
      );
      if (!asset.rows.length) fail("Недоступно", 404);
      let allowed = asset.rows[0].owner_id === a.id;
      if (!allowed) {
        const links = await db.query<Item>(
          `SELECT * FROM hc_items WHERE body @> $1::jsonb AND NOT deleted LIMIT 100`,
          [JSON.stringify({ photos: [id] })],
        );
        for (const item of links.rows)
          if (await rules.visible(item)) {
            allowed = true;
            break;
          }
      }
      if (!allowed) fail("Недоступно", 404);
      res.set({
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res
        .type("image/webp")
        .send(await fs.readFile(path.join(root(), id + ".webp")));
    } catch (error: any) {
      res.status(error.status ?? 404).end();
    }
  });
}
