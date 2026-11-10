import type { Database } from "./db";
import { randomUUID, createHash } from "node:crypto";
import { fail, bounded, uuid } from "./security";
import {
  normalizeChartDocument,
  chartCandles,
  TF_SECONDS,
  COMMUNITY_TIMEFRAMES,
} from "../../src/community/chartDocument";

export type Item = {
  id: string;
  owner_id: string;
  kind: string;
  audience: string;
  parent_id: string | null;
  conversation_id: string | null;
  chart_id: string | null;
  body: any;
  deleted: boolean;
  created_at: Date;
  revision: number;
};

/** Per-request policy: the same rules cover feeds, direct links, replies, charts and media. */
export async function policy(db: Database, viewer: string) {
  const [friends, blocks, memberships] = await Promise.all([
    db.query(
      "SELECT sender,recipient,accepted FROM hc_friendships WHERE sender=$1 OR recipient=$1",
      [viewer],
    ),
    db.query(
      "SELECT owner_id,target_id FROM hc_blocks WHERE owner_id=$1 OR target_id=$1",
      [viewer],
    ),
    db.query(
      "SELECT conversation_id,joined_at,role FROM hc_members WHERE user_id=$1",
      [viewer],
    ),
  ]);
  const accepted = new Set(
    friends.rows
      .filter((f) => f.accepted)
      .map((f) => (f.sender === viewer ? f.recipient : f.sender)),
  );
  const blocked = new Set(
    blocks.rows.map((b) => (b.owner_id === viewer ? b.target_id : b.owner_id)),
  );
  const member = new Map(memberships.rows.map((m) => [m.conversation_id, m]));
  const items = new Map<string, Promise<Item | null>>();
  function item(id: string): Promise<Item | null> {
    if (!items.has(id))
      items.set(
        id,
        db
          .query<Item>("SELECT * FROM hc_items WHERE id=$1", [id])
          .then((r) => r.rows[0] ?? null),
      );
    return items.get(id)!;
  }
  async function visible(row: Item | null, depth = 0): Promise<boolean> {
    if (!row || row.deleted || depth > 12 || blocked.has(row.owner_id))
      return false;
    if (row.conversation_id) {
      const m = member.get(row.conversation_id);
      if (!m || new Date(row.created_at) < new Date(m.joined_at)) return false;
    } else if (
      row.owner_id !== viewer &&
      row.audience !== "public" &&
      !(row.audience === "friends" && accepted.has(row.owner_id))
    )
      return false;
    if (row.parent_id && !(await visible(await item(row.parent_id), depth + 1)))
      return false;
    if (
      row.body?.sourceItemId &&
      !(await visible(await item(row.body.sourceItemId), depth + 1))
    )
      return false;
    return true;
  }
  const charts = new Map<string, Promise<any>>();
  function chart(id: string): Promise<any> {
    if (!charts.has(id))
      charts.set(
        id,
        db
          .query("SELECT * FROM hc_charts WHERE id=$1", [id])
          .then((r) => r.rows[0]),
      );
    return charts.get(id)!;
  }
  async function canReadChart(id: string, depth = 0): Promise<boolean> {
    if (depth > 12) return false;
    const row = await chart(id);
    if (!row || row.deleted || blocked.has(row.owner_id)) return false;
    if (row.parent_id && !(await canReadChart(row.parent_id, depth + 1)))
      return false;
    if (row.owner_id === viewer) return true;
    const { rows } = await db.query<Item>(
      "SELECT * FROM hc_items WHERE chart_id=$1 AND NOT deleted LIMIT 100",
      [id],
    );
    for (const entry of rows) if (await visible(entry)) return true;
    return false;
  }
  return {
    viewer,
    accepted,
    blocked,
    member,
    item,
    visible,
    chart,
    canReadChart,
  };
}
export type Policy = Awaited<ReturnType<typeof policy>>;

export async function getChart(
  db: Database,
  rules: Policy,
  id: string,
  preview = false,
) {
  if (!(await rules.canReadChart(id))) fail("Графік недоступний", 404);
  const c = await rules.chart(id);
  if (preview) return c.preview;
  const { rows } = await db.query("SELECT data FROM hc_packs WHERE hash=$1", [
    c.pack_hash,
  ]);
  const full = { ...rows[0].data, ...c.annotations };
  return full;
}
export async function saveChart(
  db: Database,
  rules: Policy,
  raw: any,
  parentId?: string,
) {
  const document = normalizeChartDocument(raw);
  if (parentId) {
    uuid(parentId);
    if (!(await rules.canReadChart(parentId)))
      fail("Оригінальний графік недоступний", 404);
    const original = await getChart(db, rules, parentId);
    for (const field of [
      "symbol",
      "exchange",
      "marketType",
      "capturedAt",
      "cutoff",
    ])
      if (document[field as keyof typeof document] !== original[field])
        fail("Відповідь має зберігати початковий ринок і момент знімка");
    // Replies may edit annotations, not rewrite their source candles. Extensions
    // must come from the shared server history or a coarser local aggregation.
    for (const tf of COMMUNITY_TIMEFRAMES) {
      const incoming = document.series[tf];
      if (!incoming?.length) continue;
      const keys = [
        ...new Set(
          incoming.map((row) =>
            [
              document.exchange,
              document.marketType,
              document.symbol,
              tf,
              Math.floor(row.time / (TF_SECONDS[tf] * 500)) *
                TF_SECONDS[tf] *
                500,
            ].join(":"),
          ),
        ),
      ];
      const cached = await db.query(
        "SELECT rows FROM hc_history WHERE key=ANY($1::text[])",
        [keys],
      );
      const expected = new Map<number, any>();
      for (const block of cached.rows)
        for (const row of block.rows)
          if (row.time + TF_SECONDS[tf] <= document.cutoff)
            expected.set(row.time, row);
      for (const row of chartCandles(original, tf) ?? [])
        expected.set(row.time, row);
      for (const row of incoming) {
        const known = expected.get(row.time);
        if (
          !known ||
          ["open", "high", "low", "close", "volume"].some(
            (field) => row[field as keyof typeof row] !== known[field],
          )
        )
          fail(
            "Свічки оригіналу незмінні. Довантажуйте історію через спільний кеш.",
          );
      }
    }
  }
  const { series, markers, drawings, viewport, ...meta } = document;
  const pack = {
    symbol: document.symbol,
    exchange: document.exchange,
    marketType: document.marketType,
    series,
  };
  const hash = createHash("sha256").update(JSON.stringify(pack)).digest("hex"),
    id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO hc_packs(hash,data) VALUES($1,$2) ON CONFLICT(hash) DO NOTHING",
      [hash, pack],
    );
    const preview = {
      ...document,
      series: {
        [document.timeframe]: document.series[document.timeframe]!.slice(-70),
      },
      drawings: [],
    };
    await tx.query(
      "INSERT INTO hc_charts(id,owner_id,pack_hash,parent_id,annotations,preview) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        rules.viewer,
        hash,
        parentId ?? null,
        { ...meta, markers, drawings, ...(viewport ? { viewport } : {}) },
        preview,
      ],
    );
  });
  return id;
}

export async function presentItem(db: Database, rules: Policy, row: Item) {
  if (!(await rules.visible(row))) return null;
  if (row.chart_id && !(await rules.canReadChart(row.chart_id))) return null;
  const { rows } = await db.query("SELECT profile FROM hc_users WHERE id=$1", [
    row.owner_id,
  ]);
  const profile = rows[0]?.profile ?? {};
  const reactions = await db.query(
    "SELECT emoji,count(*)::integer AS count FROM hc_reactions WHERE item_id=$1 GROUP BY emoji",
    [row.id],
  );
  let source = null;
  if (row.body?.sourceItemId) {
    const original = await rules.item(row.body.sourceItemId);
    if (original && (await rules.visible(original)))
      source = {
        id: original.id,
        text: original.body.text,
        owner_id: original.owner_id,
      };
  }
  return {
    ...row,
    author: { id: row.owner_id, displayName: profile.displayName ?? "Трейдер" },
    chart: row.chart_id ? await getChart(db, rules, row.chart_id, true) : null,
    reactions: reactions.rows,
    source,
  };
}

function bodyFor(raw: any, kind: string) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    JSON.stringify(raw).length > 40_000
  )
    fail("Некоректний матеріал");
  const clean = JSON.parse(JSON.stringify(raw));
  for (const field of [
    "verified",
    "apiVerified",
    "reputation",
    "points",
    "pnlVerified",
    "owner_id",
  ])
    delete clean[field];
  clean.text = bounded(clean.text ?? "", 20_000);
  clean.title = bounded(clean.title ?? "", 200);
  if (clean.sourceItemId) uuid(clean.sourceItemId);
  if (clean.strategyId) uuid(clean.strategyId);
  if (clean.photos) {
    if (!Array.isArray(clean.photos) || clean.photos.length > 4)
      fail("Дозволено до чотирьох фото");
    clean.photos = clean.photos.map(uuid);
  }
  if (
    kind === "test" &&
    !["replay", "paper", "historical"].includes(clean.mode)
  )
    fail("Тест позначається як Replay, paper або історична симуляція");
  if (kind === "strategy") {
    for (const field of [
      "market",
      "session",
      "setup",
      "entry",
      "exit",
      "risk",
      "invalidation",
    ])
      clean[field] = bounded(clean[field] ?? "", 3000);
    if (!Array.isArray(clean.checklist) || clean.checklist.length > 50)
      fail("Потрібен чекліст до 50 пунктів");
    clean.checklist = clean.checklist.map((v: any) => bounded(v, 400));
  }
  if (
    kind === "plan" &&
    (!Array.isArray(clean.tasks) || clean.tasks.length > 60)
  )
    fail("Потрібен список до 60 задач");
  if (
    !clean.text &&
    !clean.title &&
    !clean.photos?.length &&
    kind !== "message"
  )
    fail("Додайте текст, заголовок або фото");
  return clean;
}

async function enforceSource(
  db: Database,
  rules: Policy,
  source: Item,
  audience: string,
  conversationId: string | null,
) {
  if (!(await rules.visible(source))) fail("Джерело недоступне", 404);
  if (
    source.owner_id === rules.viewer &&
    source.audience === "private" &&
    !source.conversation_id
  )
    return;
  if (conversationId) {
    const members = await db.query(
      "SELECT user_id FROM hc_members WHERE conversation_id=$1",
      [conversationId],
    );
    for (const m of members.rows) {
      const other = await policy(db, m.user_id);
      if (!(await other.visible(source)))
        fail("Не всі учасники мають доступ до джерела", 403);
    }
  } else if (
    source.conversation_id ||
    source.audience === "private" ||
    (source.audience === "friends" && audience === "public")
  )
    fail("Не можна розширити аудиторію оригіналу", 403);
}

export async function createItem(db: Database, rules: Policy, input: any) {
  const kinds = [
    "post",
    "comment",
    "message",
    "strategy",
    "plan",
    "lesson",
    "test",
  ];
  if (
    !kinds.includes(input.kind) ||
    !["private", "friends", "public"].includes(input.audience ?? "private")
  )
    fail("Непідтримуваний тип матеріалу");
  const kind = input.kind,
    audience = input.audience ?? "private",
    body = bodyFor(input.body, kind);
  const parent = input.parentId ? await rules.item(uuid(input.parentId)) : null;
  if (input.parentId && (!parent || !(await rules.visible(parent))))
    fail("Матеріал недоступний", 404);
  if (kind === "comment" && (!parent || parent.kind !== "post"))
    fail("Коментар має належати доступному посту");
  const conversationId = input.conversationId
    ? uuid(input.conversationId)
    : null;
  if (
    kind === "message" &&
    (!conversationId || !rules.member.has(conversationId))
  )
    fail("Ви не учасник розмови", 403);
  if (kind !== "message" && conversationId) fail("Некоректний контекст");
  if (body.sourceItemId) {
    const source = await rules.item(body.sourceItemId);
    if (!source) fail("Джерело недоступне", 404);
    await enforceSource(db, rules, source, audience, conversationId);
  }
  if (body.strategyId) {
    const source = await rules.item(body.strategyId);
    if (!source || source.kind !== "strategy")
      fail("Стратегія недоступна", 404);
    await enforceSource(db, rules, source, audience, conversationId);
    body.strategyRevision = source.revision;
  }
  if (input.chartId) {
    const id = uuid(input.chartId),
      c = await rules.chart(id);
    if (!c || c.owner_id !== rules.viewer || !(await rules.canReadChart(id)))
      fail("Спершу створіть власну відповідь графіком", 403);
    // Every source in a reply lineage caps the new audience, including message sources.
    let ancestor = c.parent_id,
      depth = 0;
    while (ancestor) {
      if (++depth > 12) fail("Забагато рівнів відповідей");
      const original = await rules.chart(ancestor);
      const attached = await db.query<Item>(
        "SELECT * FROM hc_items WHERE chart_id=$1 AND NOT deleted LIMIT 100",
        [ancestor],
      );
      for (const source of attached.rows)
        await enforceSource(db, rules, source, audience, conversationId);
      ancestor = original?.parent_id;
    }
  }
  for (const photo of body.photos ?? []) {
    const result = await db.query(
      "SELECT id FROM hc_media WHERE id=$1 AND owner_id=$2",
      [photo, rules.viewer],
    );
    if (!result.rows.length) fail("Фото недоступне", 403);
  }
  const id = input.clientId ? uuid(input.clientId) : randomUUID();
  await db.transaction(async (tx) => {
    const previous = await tx.query(
      "SELECT owner_id,kind FROM hc_items WHERE id=$1",
      [id],
    );
    if (previous.rows.length) {
      if (
        previous.rows[0].owner_id !== rules.viewer ||
        previous.rows[0].kind !== kind
      )
        fail("Ідентифікатор уже використаний", 409);
      return;
    }
    await tx.query(
      `INSERT INTO hc_items(id,owner_id,kind,audience,parent_id,conversation_id,chart_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        rules.viewer,
        kind,
        kind === "message" ? "private" : audience,
        parent?.id ?? null,
        conversationId,
        input.chartId ?? null,
        body,
      ],
    );
    await tx.query(
      "INSERT INTO hc_item_versions(item_id,revision,body,audience) VALUES($1,1,$2,$3)",
      [id, body, kind === "message" ? "private" : audience],
    );
    if (kind === "post" || kind === "lesson")
      await tx.query(
        `INSERT INTO hc_reputation(owner_id,event_key,points,reason) VALUES($1,$2,1,$3) ON CONFLICT DO NOTHING`,
        [
          rules.viewer,
          "first-" + kind,
          kind === "lesson"
            ? "Створено навчальний матеріал"
            : "Опубліковано розбір",
        ],
      );
  });
  return id;
}

export async function editItem(
  db: Database,
  rules: Policy,
  id: string,
  input: any,
) {
  const item = await rules.item(uuid(id));
  if (!item || item.owner_id !== rules.viewer || item.deleted)
    fail("Матеріал недоступний", 404);
  const body = bodyFor(input.body, item.kind);
  if (
    body.sourceItemId !== item.body.sourceItemId ||
    body.strategyId !== item.body.strategyId
  )
    fail("Для іншого джерела створіть нову версію матеріалу");
  const audience = input.audience ?? item.audience;
  const levels = ["private", "friends", "public"];
  if (
    !levels.includes(audience) ||
    levels.indexOf(audience) > levels.indexOf(item.audience)
  )
    fail(
      "Для розширення аудиторії створіть окрему публікацію з попереднім переглядом",
    );
  for (const photo of body.photos ?? []) {
    const owned = await db.query(
      "SELECT id FROM hc_media WHERE id=$1 AND owner_id=$2",
      [photo, rules.viewer],
    );
    if (!owned.rows.length) fail("Фото недоступне", 403);
  }
  // Source and published chart are immutable; narrowing visibility is immediate.
  await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      "UPDATE hc_items SET body=$2,revision=revision+1,audience=$4,updated_at=now() WHERE id=$1 AND revision=$3 RETURNING revision",
      [id, body, input.revision, audience],
    );
    if (!rows.length) fail("Матеріал уже змінено. Оновіть сторінку.", 409);
    await tx.query(
      "INSERT INTO hc_item_versions(item_id,revision,body,audience) VALUES($1,$2,$3,$4)",
      [id, rows[0].revision, body, audience],
    );
  });
}
