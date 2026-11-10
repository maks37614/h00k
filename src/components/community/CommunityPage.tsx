import { AccountSecuritySettings } from "./AccountSecuritySettings";
import { PublicProfileSettings } from "./PublicProfileSettings";
import { STRATEGY_PRESETS } from "../hookchart/strategyEngine";
import { saveChartArchive } from "../../community/archiveChart";
import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Users,
  ShieldCheck,
  MessageCircle,
  CalendarCheck,
  BookOpen,
  Settings,
  X,
  Plus,
  ArrowLeft,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useArchive } from "../../context/ArchiveContext";
import { apiJson } from "../../utils/apiFetch";
import { parseWatchlistKey } from "../../utils/watchlistUtils";
import {
  captureChartDocument,
  cloneChartDocument,
  type ChartDocument,
} from "../../community/chartDocument";
import type {
  ArchivedFormation,
  DetectedFormation,
  Timeframe,
} from "../../types";
import { ChartPreview } from "./ChartPreview";
import "./community.css";
const SharedHookChart = lazy(() => import("./SharedHookChart"));
type Tab =
  | "feed"
  | "day"
  | "strategies"
  | "trades"
  | "learning"
  | "chats"
  | "friends"
  | "profile"
  | "settings";
type Target = {
  kind: "post" | "comment" | "message";
  parentId?: string;
  conversationId?: string;
};
type DraftChart = {
  document: ChartDocument;
  parentId?: string;
  historyId?: string;
  target: Target;
};
const emojis = ["👍", "🔥", "🤔", "📈", "📉", "✅", "💡", "🙂"];
function Audience({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label="Аудиторія"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="private">Лише я</option>
      <option value="friends">Друзі</option>
      <option value="public">Публічно</option>
    </select>
  );
}
function useResource(key: string, loader: () => Promise<any>) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [version, update] = useState(0),
    fn = useRef(loader);
  fn.current = loader;
  useEffect(() => {
    let active = true;
    setError("");
    setData(null);
    void fn
      .current()
      .then((value) => {
        if (active) setData(value);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [key, version]);
  return { data, error, refresh: () => update((v) => v + 1) };
}
const post = (url: string, body: unknown) =>
  apiJson(url, { method: "POST", body: JSON.stringify(body) });
const api = "/api/community";

export function CommunityPage({ onReplay }: { onReplay: () => void }) {
  const { user, profile } = useAuth();
  const { archivedFormations } = useArchive();
  const [tab, setTab] = useState<Tab>(() =>
      new URLSearchParams(location.hash.split("?")[1] ?? "").get("section") ===
      "settings"
        ? "settings"
        : new URLSearchParams(location.hash.split("?")[1] ?? "").get("section") === "profile" ? "profile" : "feed",
    ),
    [notice, setNotice] = useState(""),
    [picker, setPicker] = useState<Target | null>(null),
    [draft, setDraft] = useState<DraftChart | null>(null);
  const [viewProfile, setViewProfile] = useState<string | null>(() => {
    const owner = new URLSearchParams(location.hash.split("?")[1] ?? "").get("owner");
    return owner && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(owner) ? owner : null;
  }),
    [revision, bump] = useState(0);
  async function run(fn: () => Promise<unknown>) {
    setNotice("");
    try {
      await fn();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Не вдалося виконати дію",
      );
    }
  }
  const changed = () => bump((v) => v + 1);
  useEffect(() => {
    const jump = () => {
      const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
      if (query.get("section") === "profile") {
        const owner = query.get("owner");
        setViewProfile(owner && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(owner) ? owner : null);
        setTab("profile");
      }
      if (new URLSearchParams(location.hash.split("?")[1] ?? "").has("post"))
        setTab("feed");
      if (
        new URLSearchParams(location.hash.split("?")[1] ?? "").get(
          "section",
        ) === "settings"
      )
        setTab("settings");
    };
    window.addEventListener("hashchange", jump);
    return () => window.removeEventListener("hashchange", jump);
  }, []);
  const openChart = (item: any, target?: Target) =>
    run(async () => {
      const data = await apiJson(api + "/charts/" + item.chart_id);
      setDraft({
        document: cloneChartDocument(data.document),
        parentId: item.chart_id,
        historyId: item.chart_id,
        target: target ?? { kind: "comment", parentId: item.id },
      });
    });
  const pickArchive = async (item: ArchivedFormation) => {
    const target = picker!;
    setPicker(null);
    if (item.chartDocument) {
      setDraft({
        document: cloneChartDocument(item.chartDocument),
        parentId: item.sourceChartId,
        historyId: item.sourceChartId,
        target,
      });
      return;
    }
    if (item.hasChartDocument) {
      await run(async () => {
        const full = await apiJson(
          api + "/archives/" + encodeURIComponent(item.id),
        );
        setDraft({
          document: cloneChartDocument(full.item.chartDocument),
          parentId: full.item.sourceChartId,
          historyId: full.item.sourceChartId,
          target,
        });
      });
      return;
    }
    await run(async () => {
      const before = Math.floor(item.savedAtTimestamp / 1000),
        params = new URLSearchParams({
          symbol: item.symbol,
          exchange: item.exchange,
          marketType: item.marketType,
          timeframe: item.timeframe,
          before: String(before),
        });
      const data = await apiJson(api + "/history?" + params);
      setDraft({
        document: captureChartDocument({
          symbol: item.symbol,
          exchange: item.exchange,
          marketType: item.marketType,
          timeframe: item.timeframe,
          capturedAt: item.savedAtTimestamp,
          candles: data.rows,
          markers: item.markers,
          drawings: [],
        }),
        target,
      });
    });
  };
  const pickCoin = async (key: string) => {
    const target = picker!,
      coin = parseWatchlistKey(key);
    setPicker(null);
    await run(async () => {
      const timeframe: Timeframe = profile?.defaultTimeframe ?? "1h",
        params = new URLSearchParams({
          ...coin,
          timeframe,
          before: String(Math.floor(Date.now() / 1000)),
        });
      const data = await apiJson(api + "/history?" + params);
      setDraft({
        document: captureChartDocument({
          ...coin,
          timeframe,
          candles: data.rows,
          markers: [],
          drawings: [],
        }),
        target,
      });
    });
  };
  const nav: [Tab, string, React.ReactNode][] = [
    ["feed", "Стрічка", <Users size={16} />],
    ["day", "Мій день", <CalendarCheck size={16} />],
    ["strategies", "Стратегії", <BookOpen size={16} />],
    ["trades", "Угоди та статистика", <ShieldCheck size={16} />],
    ["learning", "Навчання", <BookOpen size={16} />],
    ["chats", "Чати", <MessageCircle size={16} />],
    ["friends", "Друзі", <Users size={16} />],
    ["profile", "Профіль", <Users size={16} />],
    ["settings", "Налаштування", <Settings size={16} />],
  ];
  if (!user)
    return (
      <section className="community-shell">
        <p>Увійдіть у h00k, щоб відкрити спільноту.</p>
      </section>
    );
  return (
    <section className="community-shell">
      <header className="community-intro">
        <div>
          <span className="community-eyebrow">h00k COMMUNITY</span>
          <h1>Досвід, який можна обговорити й перевірити.</h1>
          <p>
            Плануйте день, працюйте зі стратегіями та діліться власним розбором.
            Ви визначаєте, хто бачить ваші дані.
          </p>
        </div>
        <button type="button" onClick={() => setTab("settings")}>
          <ShieldCheck size={18} /> Прозорість і захист
        </button>
      </header>
      <nav className="community-nav" aria-label="Розділи спільноти">
        {nav.map(([id, title, icon]) => (
          <button
            type="button"
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => {
              setTab(id);
              setViewProfile(null);
            }}
          >
            {icon}
            {title}
          </button>
        ))}
      </nav>
      {notice && (
        <div className="community-notice" role="status">
          {notice}
          <button
            type="button"
            aria-label="Закрити повідомлення"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className="community-content" key={user.uid}>
        {tab === "feed" && (
          <Feed
            key={"feed" + revision}
            onPick={setPicker}
            onChart={openChart}
            run={run}
            onProfile={(id) => {
              setViewProfile(id);
              setTab("profile");
            }}
          />
        )}
        {tab === "day" && (
          <Workspace
            kind="plan"
            title="Мій день"
            onReplay={onReplay}
            run={run}
          />
        )}
        {tab === "strategies" && (
          <Workspace
            kind="strategy"
            title="Стратегії"
            onReplay={onReplay}
            run={run}
          />
        )}
        {tab === "learning" && (
          <>
            <Workspace
              kind="lesson"
              title="Уроки та знання"
              onReplay={onReplay}
              run={run}
            />
            <Workspace
              kind="test"
              title="Лабораторія спільних тестів"
              onReplay={onReplay}
              run={run}
            />
          </>
        )}
        {tab === "trades" && <Trades run={run} />}
        {tab === "chats" && (
          <Chats
            revision={revision}
            onPick={setPicker}
            onChart={openChart}
            run={run}
          />
        )}
        {tab === "friends" && (
          <Friends
            run={run}
            onProfile={(id) => {
              setViewProfile(id);
              setTab("profile");
            }}
          />
        )}
        {tab === "profile" && (
          <Profile
            id={viewProfile ?? user.uid}
            onChart={openChart}
            onPick={setPicker}
            run={run}
          />
        )}
        {tab === "settings" && <CommunitySettings run={run} />}
      </div>
      {picker && (
        <div className="community-backdrop">
          <section
            className="community-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Додати графік із збережень"
          >
            <header>
              <h2>Виберіть збережений інструмент</h2>
              <button
                type="button"
                aria-label="Закрити"
                onClick={() => setPicker(null)}
              >
                <X />
              </button>
            </header>
            <p>
              Формації використовують уже збережений знімок. Для старого архіву
              або монети без свічок історія завантажується один раз через
              спільний кеш.
            </p>
            <h3>Обрані формації</h3>
            <div className="community-picker">
              {archivedFormations.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => void pickArchive(item)}
                >
                  <b>{item.symbol}</b>
                  <span>
                    {item.formationName} · {item.timeframe}
                  </span>
                </button>
              ))}
              {!archivedFormations.length && (
                <p>Збережіть формацію іконкою на графіку скрінера.</p>
              )}
            </div>
            <h3>Обрані монети</h3>
            <div className="community-picker">
              {(profile?.watchlist ?? []).map((key) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => void pickCoin(key)}
                >
                  {key}
                </button>
              ))}
              {!profile?.watchlist?.length && (
                <p>Додайте монети до наявного списку обраного у скрінері.</p>
              )}
            </div>
          </section>
        </div>
      )}
      {draft && (
        <ChartDialog
          key={draft.parentId ?? draft.document.capturedAt}
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          notice={notice}
          onSaved={() => {
            setDraft(null);
            changed();
          }}
          run={run}
        />
      )}
    </section>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<void>;
function Composer({
  target,
  onPick,
  onSent,
  run,
}: {
  target: Target;
  onPick: (target: Target) => void;
  onSent: () => void;
  run: Run;
}) {
  const [text, setText] = useState(""),
    [audience, setAudience] = useState("private"),
    [photos, setPhotos] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    clientId = useRef(crypto.randomUUID());
  return (
    <form
      className="community-composer"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void run(async () => {
          await post(api + "/items", {
            kind: target.kind,
            parentId: target.parentId,
            conversationId: target.conversationId,
            audience,
            clientId: clientId.current,
            body: { text, photos },
          });
          setText("");
          setPhotos([]);
          clientId.current = crypto.randomUUID();
          onSent();
        }).finally(() => setBusy(false));
      }}
    >
      <textarea
        aria-label={
          target.kind === "comment"
            ? "Текст коментаря"
            : target.kind === "message"
              ? "Текст повідомлення"
              : "Текст публікації"
        }
        placeholder={
          target.kind === "post"
            ? "Якою ситуацією або висновком поділитеся?"
            : "Ваша відповідь…"
        }
        value={text}
        maxLength={20_000}
        onChange={(e) => setText(e.target.value)}
        required={!photos.length}
      />
      <div className="community-composer-tools">
        <div>
          {emojis.map((emoji) => (
            <button
              type="button"
              key={emoji}
              aria-label={`Додати ${emoji}`}
              onClick={() => setText((t) => t + emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => onPick(target)}>
          + Графік зі збережень
        </button>
        <label className="community-file">
          + Фото
          <input
            aria-label="Додати фото"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={photos.length >= 4 || busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setBusy(true);
                void run(async () => {
                  const d = await apiJson(api + "/media", {
                    method: "POST",
                    headers: { "Content-Type": file.type },
                    body: file,
                  });
                  setPhotos((p) => [...p, d.id]);
                }).finally(() => setBusy(false));
              }
              e.target.value = "";
            }}
          />
        </label>
        {target.kind !== "message" && (
          <Audience value={audience} onChange={setAudience} />
        )}
        <button type="submit" className="community-primary" disabled={busy}>
          {busy ? "Збереження…" : "Надіслати"}
        </button>
      </div>
      {!!photos.length && (
        <div className="community-photo-strip">
          {photos.map((id) => (
            <button
              type="button"
              key={id}
              title="Видалити фото"
              onClick={() => setPhotos((p) => p.filter((v) => v !== id))}
            >
              <img alt="Фото для публікації" src={api + "/media/" + id} />
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

function Feed({
  onPick,
  onChart,
  run,
  onProfile,
}: {
  onPick: (t: Target) => void;
  onChart: (item: any, target?: Target) => Promise<void>;
  run: Run;
  onProfile: (id: string) => void;
}) {
  const { user } = useAuth();
  const [mode, setMode] = useState(
    () => localStorage.getItem("h00k-community-feed:" + user?.uid) ?? "friends",
  );
  const [data, setData] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const currentMode = useRef(mode);
  const requestNumber = useRef(0);
  currentMode.current = mode;
  const [linkedId, setLinkedId] = useState(
    () =>
      new URLSearchParams(location.hash.split("?")[1] ?? "").get("post") ?? "",
  );
  const linked = useResource("linked-post:" + linkedId, () =>
    linkedId
      ? apiJson(api + "/items/" + encodeURIComponent(linkedId))
      : Promise.resolve({ item: null }),
  );
  useEffect(() => {
    const jump = () =>
      setLinkedId(
        new URLSearchParams(location.hash.split("?")[1] ?? "").get("post") ??
          "",
      );
    window.addEventListener("hashchange", jump);
    return () => window.removeEventListener("hashchange", jump);
  }, []);
  async function load(before?: string) {
    const startedMode = mode;
    const request = ++requestNumber.current;
    setLoading(true);
    try {
      const d = await apiJson(
        api +
          "/feed?" +
          new URLSearchParams({ mode, ...(before ? { before } : {}) }),
      );
      if (
        currentMode.current !== startedMode ||
        requestNumber.current !== request
      )
        return;
      setData((old) => (before ? [...old, ...d.items] : d.items));
      setNext(d.next);
      setError("");
    } catch (e) {
      if (
        currentMode.current !== startedMode ||
        requestNumber.current !== request
      )
        return;
      setError(e instanceof Error ? e.message : "Стрічка недоступна");
    } finally {
      if (
        currentMode.current === startedMode &&
        requestNumber.current === request
      )
        setLoading(false);
    }
  }
  useEffect(() => {
    setData([]);
    setNext(null);
    void load();
    localStorage.setItem("h00k-community-feed:" + user?.uid, mode);
  }, [mode, user?.uid]);
  return (
    <>
      <div className="community-section-heading">
        <h2>Стрічка</h2>
        <div className="community-segment">
          <button
            type="button"
            aria-pressed={mode === "friends"}
            onClick={() => setMode("friends")}
          >
            Друзі
          </button>
          <button
            type="button"
            aria-pressed={mode === "public"}
            onClick={() => setMode("public")}
          >
            Публічні
          </button>
        </div>
      </div>
      <Composer
        target={{ kind: "post" }}
        onPick={onPick}
        onSent={() => void load()}
        run={run}
      />
      {linkedId && (
        <section aria-label="Дописи за посиланням">
          <button
            type="button"
            onClick={() => {
              setLinkedId("");
              history.replaceState(null, "", "#community");
            }}
          >
            Закрити допис за посиланням
          </button>
          {linked.error && <p role="status">{linked.error}</p>}
          {linked.data?.item && (
            <ItemCard
              item={linked.data.item}
              onChart={onChart}
              onPick={onPick}
              run={run}
              refresh={linked.refresh}
              onProfile={onProfile}
            />
          )}
        </section>
      )}
      {error && <p role="status">{error}</p>}
      {loading && !data.length && <p>Завантаження…</p>}
      {!loading && !data.length && !error && (
        <div className="community-empty">
          Тут будуть{" "}
          {mode === "friends" ? "дописи ваших друзів" : "публічні дописи"}.
          Збережіть формацію у скрінері й поділіться своїм першим розбором.
        </div>
      )}
      {data
        .filter((item) => item.id !== linked.data?.item?.id)
        .map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            onChart={onChart}
            onPick={onPick}
            run={run}
            refresh={() => void load()}
            onProfile={onProfile}
          />
        ))}
      {next && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(next)}
        >
          Завантажити ще
        </button>
      )}
    </>
  );
}

function ItemCard({
  item,
  onChart,
  onPick,
  run,
  refresh,
  onProfile,
}: {
  item: any;
  onChart: (item: any, target?: Target) => Promise<void>;
  onPick: (t: Target) => void;
  run: Run;
  refresh: () => void;
  onProfile?: (id: string) => void;
}) {
  const { user } = useAuth();
  const [reply, setReply] = useState(false);
  const thread = useResource((reply ? "open:" : "closed:") + item.id, () =>
    reply
      ? apiJson(api + "/items/" + item.id + "/comments")
      : Promise.resolve(null),
  );
  const [moreComments, setMoreComments] = useState<any[]>([]),
    [nextComment, setNextComment] = useState<string | null>(null);
  useEffect(() => {
    setMoreComments([]);
    setNextComment(thread.data?.next ?? null);
  }, [thread.data]);
  const target: Target =
    item.kind === "message"
      ? { kind: "message", conversationId: item.conversation_id }
      : { kind: "comment", parentId: item.id };
  return (
    <article className="community-card">
      <header>
        <button
          type="button"
          className="community-author"
          onClick={() => onProfile?.(item.owner_id)}
        >
          <span className="community-avatar">
            {(item.author?.displayName ?? "T").slice(0, 1)}
          </span>
          <span>
            <b>{item.author?.displayName ?? "Трейдер"}</b>
            <small>
              {new Date(item.created_at).toLocaleString("uk-UA")} ·{" "}
              {item.kind === "message"
                ? "Учасникам чату"
                : item.audience === "public"
                  ? "Публічно"
                  : item.audience === "friends"
                    ? "Друзям"
                    : "Лише автору"}
              {item.revision > 1 ? " · змінено" : ""}
            </small>
          </span>
        </button>
        <div>
          {item.owner_id === user?.uid ? (
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await apiJson(api + "/items/" + item.id, {
                    method: "DELETE",
                  });
                  refresh();
                })
              }
            >
              Видалити
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                const reason = window.prompt("Причина скарги");
                if (reason)
                  void run(async () => {
                    await post(api + "/reports", { itemId: item.id, reason });
                  });
              }}
            >
              Скарга
            </button>
          )}
        </div>
      </header>
      {item.body?.title && <h3>{item.body.title}</h3>}
      <p className="community-text">{item.body?.text}</p>
      {item.source && (
        <blockquote>
          <b>Поширений матеріал</b>
          <p>{item.source.text}</p>
        </blockquote>
      )}
      {item.chart && (
        <ChartPreview
          document={item.chart}
          onOpen={() => void onChart(item, target)}
        />
      )}
      {!!item.body?.photos?.length && (
        <div className="community-photo-strip">
          {item.body.photos.map((id: string) => (
            <a
              key={id}
              href={api + "/media/" + id}
              target="_blank"
              rel="noreferrer"
            >
              <img
                loading="lazy"
                alt="Вкладення до матеріалу"
                src={api + "/media/" + id}
              />
            </a>
          ))}
        </div>
      )}
      <footer className="community-card-actions">
        {["👍", "❤️", "🔥", "🤔"].map((emoji) => (
          <button
            type="button"
            key={emoji}
            onClick={() =>
              void run(async () => {
                await post(api + "/items/" + item.id + "/reaction", { emoji });
                refresh();
              })
            }
          >
            {emoji}{" "}
            {item.reactions?.find((r: any) => r.emoji === emoji)?.count ?? ""}
          </button>
        ))}
        {item.kind === "post" && (
          <button type="button" onClick={() => setReply((v) => !v)}>
            Коментарі
          </button>
        )}
        {item.chart && (
          <button type="button" onClick={() => void onChart(item, target)}>
            Відповісти графіком
          </button>
        )}
        {item.kind === "post" && (
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                await post(api + "/items", {
                  kind: "post",
                  audience: item.audience,
                  body: {
                    text: "",
                    title: "Поширений розбір",
                    sourceItemId: item.id,
                  },
                });
                refresh();
              })
            }
          >
            На свою стіну
          </button>
        )}
        {item.audience === "public" && item.kind === "post" && (
          <a
            target="_blank"
            rel="noopener noreferrer"
            href={
              "https://t.me/share/url?" +
              new URLSearchParams({
                url: location.origin + "/#community?post=" + item.id,
                text: item.body.text?.slice(0, 500) ?? "",
              })
            }
          >
            Telegram ↗
          </a>
        )}
      </footer>
      {reply && (
        <div className="community-comments">
          {thread.error && <p role="status">{thread.error}</p>}
          {[...(thread.data?.items ?? []), ...moreComments].map(
            (comment: any) => (
              <div className="community-comment" key={comment.id}>
                <b>{comment.author?.displayName}</b>
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      if (comment.owner_id === user?.uid)
                        await apiJson(api + "/items/" + comment.id, {
                          method: "DELETE",
                        });
                      else {
                        const reason = window.prompt(
                          "Причина скарги на коментар",
                        );
                        if (!reason) return;
                        await post(api + "/reports", {
                          itemId: comment.id,
                          reason,
                        });
                      }
                      thread.refresh();
                    })
                  }
                >
                  {comment.owner_id === user?.uid ? "Видалити" : "Скарга"}
                </button>
                <p>{comment.body.text}</p>
                {comment.chart && (
                  <ChartPreview
                    document={comment.chart}
                    onOpen={() =>
                      void onChart(comment, {
                        kind: "comment",
                        parentId: item.id,
                      })
                    }
                  />
                )}
                <div className="community-photo-strip">
                  {comment.body.photos?.map((id: string) => (
                    <img
                      key={id}
                      alt="Фото в коментарі"
                      loading="lazy"
                      src={api + "/media/" + id}
                    />
                  ))}
                </div>
              </div>
            ),
          )}
          {nextComment && (
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  const data = await apiJson(
                    api +
                      "/items/" +
                      item.id +
                      "/comments?after=" +
                      nextComment,
                  );
                  setMoreComments((old) => [
                    ...new Map(
                      [...old, ...data.items].map((comment: any) => [
                        comment.id,
                        comment,
                      ]),
                    ).values(),
                  ]);
                  setNextComment(data.next);
                })
              }
            >
              Наступні коментарі
            </button>
          )}
          <Composer
            target={target}
            onPick={onPick}
            onSent={() => {
              thread.refresh();
              refresh();
            }}
            run={run}
          />
        </div>
      )}
    </article>
  );
}

function ChartDialog({
  draft,
  onChange,
  onClose,
  onSaved,
  run,
  notice,
}: {
  notice: string;
  draft: DraftChart;
  onChange: (v: DraftChart) => void;
  onClose: () => void;
  onSaved: () => void;
  run: Run;
}) {
  const { user } = useAuth();
  const [text, setText] = useState(""),
    [audience, setAudience] = useState("private"),
    [target, setTarget] = useState(draft.target),
    [busy, setBusy] = useState(false),
    [savedId, setSavedId] = useState<string | null>(draft.historyId ?? null);
  const conversations = useResource("chart-conversations", () =>
    apiJson(api + "/conversations"),
  );
  async function chartId() {
    const d = await post(api + "/charts", {
      document: draft.document,
      parentId: draft.parentId,
    });
    setSavedId(d.id);
    return d.id as string;
  }
  const saveArchive = () =>
    run(async () => {
      await saveChartArchive(draft.document, user!.uid, text, draft.parentId);
      window.dispatchEvent(new Event("h00k:archive-saved"));
      onSaved();
    });
  return (
    <div className="community-backdrop">
      <section
        className="community-dialog community-chart-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Ваш варіант HookChart"
      >
        <header>
          <div>
            <h2>Ваш варіант розбору</h2>
            <p>Оригінальний матеріал зберігається без змін</p>
          </div>
          <button type="button" aria-label="Закрити редактор" onClick={onClose}>
            <X />
          </button>
        </header>
        <Suspense fallback={<p>Завантаження рушія HookChart…</p>}>
          <SharedHookChart
            value={draft.document}
            onChange={(document) => onChange({ ...draft, document })}
            onHistory={async (timeframe, before) => {
              const id = savedId ?? (await chartId());
              return (
                await apiJson(
                  api +
                    "/charts/" +
                    id +
                    "/history?" +
                    new URLSearchParams({ timeframe, before: String(before) }),
                )
              ).rows;
            }}
          />
        </Suspense>
        {notice && (
          <p role="alert" className="community-notice">
            {notice}
          </p>
        )}
        <textarea
          aria-label="Пояснення розмітки"
          placeholder="Поясніть свій варіант…"
          value={text}
          maxLength={20_000}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="community-composer-tools">
          <select
            aria-label="Куди надіслати розбір"
            value={
              target.kind === "message"
                ? "message:" + target.conversationId
                : target.kind
            }
            onChange={(e) => {
              if (e.target.value.startsWith("message:"))
                setTarget({
                  kind: "message",
                  conversationId: e.target.value.slice(8),
                });
              else if (e.target.value === "comment") setTarget(draft.target);
              else setTarget({ kind: "post" });
            }}
          >
            <option value="post">На свою стіну</option>
            {draft.target.kind === "comment" && (
              <option value="comment">Коментарем до оригіналу</option>
            )}
            {conversations.data?.items?.map((c: any) => (
              <option key={c.id} value={"message:" + c.id}>
                {c.is_group ? "Група" : "Чат"}: {c.title}
              </option>
            ))}
          </select>
          {target.kind !== "message" && (
            <Audience value={audience} onChange={setAudience} />
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveArchive()}
          >
            Зберегти до обраних формацій
          </button>
          <button
            type="button"
            className="community-primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void run(async () => {
                const id = await chartId();
                await post(api + "/items", {
                  ...target,
                  audience,
                  chartId: id,
                  body: { text: text || "Мій варіант розбору графіка" },
                });
                onSaved();
              }).finally(() => setBusy(false));
            }}
          >
            Надіслати розбір
          </button>
        </div>
      </section>
    </div>
  );
}

function Workspace({
  kind,
  title,
  onReplay,
  run,
}: {
  kind: "plan" | "strategy" | "lesson" | "test";
  title: string;
  onReplay: () => void;
  run: Run;
}) {
  const { user } = useAuth();
  const resource = useResource(kind, () =>
    apiJson(api + "/items?kind=" + kind),
  );
  const [editing, setEditing] = useState<any>(null),
    [name, setName] = useState(""),
    [text, setText] = useState(""),
    [audience, setAudience] = useState("private"),
    [checklist, setChecklist] = useState(""),
    [fields, setFields] = useState<Record<string, string>>({}),
    [mode, setMode] = useState("replay"),
    [busy, setBusy] = useState(false);
  const reset = () => {
    setEditing(null);
    setName("");
    setText("");
    setChecklist("");
    setFields({});
  };
  return (
    <section className="community-workspace">
      <div className="community-section-heading">
        <h2>{title}</h2>
        {(kind === "test" || kind === "strategy") && (
          <button type="button" onClick={onReplay}>
            Відкрити наявний Replay ↗
          </button>
        )}
      </div>
      <p className="community-hint">
        {kind === "plan"
          ? "Плануйте спостереження, навчання та відпочинок. День без угод також є повноцінним. Відмітки задач — ваша самооцінка."
          : kind === "strategy"
            ? "Правила зберігаються версіями. Зміна не переписує старі плани та результати."
            : kind === "test"
              ? "Результати тут — авторські навчальні звіти, окремі від підтверджених API-угод. Для спільної практики створіть групову переписку."
              : "Діліться поясненнями, прикладами й вправами. Указуйте джерела та обмеження."}
      </p>
      <form
        className="community-card community-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void run(async () => {
            const body: any = { title: name, text, ...fields };
            if (kind === "strategy")
              body.checklist = checklist
                .split("\n")
                .map((v) => v.trim())
                .filter(Boolean);
            if (kind === "plan")
              body.tasks = checklist
                .split("\n")
                .map((v) => ({ text: v.trim(), done: false }))
                .filter((v) => v.text);
            if (kind === "test") body.mode = mode;
            if (editing)
              await apiJson(api + "/items/" + editing.id, {
                method: "PATCH",
                body: JSON.stringify({
                  body,
                  audience,
                  revision: editing.revision,
                }),
              });
            else await post(api + "/items", { kind, audience, body });
            reset();
            resource.refresh();
          }).finally(() => setBusy(false));
        }}
      >
        <h3>{editing ? "Нова версія" : "Створити матеріал"}</h3>
        <input
          aria-label="Назва матеріалу"
          placeholder="Назва"
          value={name}
          maxLength={200}
          required
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          aria-label="Опис матеріалу"
          placeholder={
            kind === "lesson"
              ? "Мета, пояснення, приклади, вправа та джерела"
              : "План, правила або пояснення"
          }
          value={text}
          maxLength={20_000}
          onChange={(e) => setText(e.target.value)}
        />
        {kind === "strategy" && (
          <div className="community-fields">
            {[
              ["market", "Ринки й інструменти"],
              ["session", "Сесії й таймфрейми"],
              ["setup", "Передумови ситуації"],
              ["entry", "Умови входу"],
              ["invalidation", "Коли ідея не діє"],
              ["exit", "Супровід і вихід"],
              ["risk", "Особисті правила ризику"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <textarea
                  value={fields[key] ?? ""}
                  maxLength={3000}
                  onChange={(e) =>
                    setFields((f) => ({ ...f, [key]: e.target.value }))
                  }
                />
              </label>
            ))}
          </div>
        )}
        {(kind === "plan" || kind === "strategy") && (
          <textarea
            aria-label="Чекліст"
            placeholder="Задачі або перевірки — кожна з нового рядка"
            value={checklist}
            maxLength={15_000}
            onChange={(e) => setChecklist(e.target.value)}
          />
        )}
        {kind === "test" && (
          <select
            aria-label="Режим тесту"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="replay">Replay</option>
            <option value="paper">Paper / forward</option>
            <option value="historical">Історичний тест</option>
          </select>
        )}
        <div className="community-composer-tools">
          <Audience value={audience} onChange={setAudience} />
          <button disabled={busy} className="community-primary">
            {busy ? "Збереження…" : "Зберегти"}
          </button>
          {editing && (
            <button type="button" onClick={reset}>
              Скасувати редагування
            </button>
          )}
        </div>
      </form>
      {kind === "strategy" && (
        <div className="community-card">
          <h3>Почати з шаблона</h3>
          <p>Шаблон структурує ваші правила й не є обіцянкою прибутковості.</p>
          {STRATEGY_PRESETS.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => {
                reset();
                setName(template.name);
                setText(
                  template.description +
                    "\n\n" +
                    (template.futuresNote
                      ? "Потребує даних futures/OI/funding. Replay не підтверджує відсутні дані."
                      : "") +
                    "\nЦе копія наявного пресету HookChart для формулювання власних правил.",
                );
                setFields({
                  sourcePreset: template.id,
                  session: template.requiredTfs.join(", "),
                });
                setChecklist(template.bullets.join("\n"));
              }}
            >
              {template.name}
            </button>
          ))}
        </div>
      )}
      {resource.error && <p role="status">{resource.error}</p>}
      {resource.data?.items?.map((item: any) => (
        <article className="community-card" key={item.id}>
          <header>
            <h3>{item.body.title}</h3>
            <small>
              Версія {item.revision} · {item.author.displayName} ·{" "}
              {item.audience}
            </small>
          </header>
          <p className="community-text">{item.body.text}</p>
          {kind === "strategy" && (
            <dl className="community-strategy-rules">
              {[
                "market",
                "session",
                "setup",
                "entry",
                "invalidation",
                "exit",
                "risk",
              ].map(
                (key) =>
                  item.body[key] && (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{item.body[key]}</dd>
                    </div>
                  ),
              )}
            </dl>
          )}
          {kind === "test" && (
            <span className="community-badge">
              Симуляція · {item.body.mode} · звіт автора
            </span>
          )}
          {item.body.checklist?.map((task: string, i: number) => (
            <p key={i}>□ {task}</p>
          ))}
          {item.body.tasks?.map((task: any, i: number) => (
            <label className="community-task" key={i}>
              <input
                type="checkbox"
                checked={!!task.done}
                disabled={item.owner_id !== user?.uid}
                onChange={() =>
                  void run(async () => {
                    const tasks = item.body.tasks.map(
                      (t: any, index: number) =>
                        index === i ? { ...t, done: !t.done } : t,
                    );
                    await apiJson(api + "/items/" + item.id, {
                      method: "PATCH",
                      body: JSON.stringify({
                        revision: item.revision,
                        body: { ...item.body, tasks },
                      }),
                    });
                    resource.refresh();
                  })
                }
              />
              {task.text}
            </label>
          ))}
          <footer>
            {item.owner_id === user?.uid ? (
              <button
                type="button"
                onClick={() => {
                  setEditing(item);
                  setName(item.body.title);
                  setText(item.body.text);
                  setAudience(item.audience);
                  setFields(item.body);
                  setChecklist(
                    (
                      item.body.checklist ??
                      item.body.tasks?.map((t: any) => t.text) ??
                      []
                    ).join("\n"),
                  );
                  setMode(item.body.mode ?? "replay");
                }}
              >
                Редагувати з історією версій
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    await post(api + "/items", {
                      kind,
                      audience: "private",
                      body: {
                        ...item.body,
                        sourceItemId: item.id,
                        title: "Копія: " + item.body.title,
                      },
                    });
                    resource.refresh();
                  })
                }
              >
                Додати власну приватну копію
              </button>
            )}
          </footer>
        </article>
      ))}
    </section>
  );
}

function Friends({
  run,
  onProfile,
}: {
  run: Run;
  onProfile: (id: string) => void;
}) {
  const resource = useResource("friends", () => apiJson(api + "/friends"));
  const [q, setQ] = useState(""),
    [people, setPeople] = useState<any[]>([]);
  return (
    <>
      <h2>Друзі та запити</h2>
      <form
        className="community-search"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setPeople(
              (await apiJson(api + "/people?q=" + encodeURIComponent(q)))
                .people,
            );
          });
        }}
      >
        <input
          aria-label="Пошук трейдера"
          value={q}
          minLength={2}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Псевдонім трейдера"
        />
        <button>Шукати</button>
      </form>
      {resource.error && <p>{resource.error}</p>}
      {[...(resource.data?.people ?? []), ...people].map(
        (person: any, i: number) => (
          <div
            className="community-card community-person"
            key={person.id + ":" + i}
          >
            <button type="button" onClick={() => onProfile(person.id)}>
              {person.displayName}
            </button>
            <span>
              {person.accepted
                ? "Друзі"
                : person.incoming
                  ? "Вхідний запит"
                  : ""}
            </span>
            {!person.accepted && (
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    await post(api + "/friends/" + person.id, {});
                    resource.refresh();
                    setPeople([]);
                  })
                }
              >
                {person.incoming ? "Прийняти" : "Запит дружби"}
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await post(api + "/blocks/" + person.id, {});
                  resource.refresh();
                  setPeople([]);
                })
              }
            >
              Заблокувати
            </button>
          </div>
        ),
      )}
      <p className="community-hint">
        Незнайомці не можуть автоматично додати вас у групу. Запрошення в першій
        версії доступні лише прийнятим друзям.
      </p>
    </>
  );
}

function Chats({
  revision,
  onPick,
  onChart,
  run,
}: {
  revision: number;
  onPick: (t: Target) => void;
  onChart: (item: any, target?: Target) => Promise<void>;
  run: Run;
}) {
  const list = useResource("chats:" + revision, () =>
      apiJson(api + "/conversations"),
    ),
    friends = useResource("chat-friends", () => apiJson(api + "/friends"));
  const [id, setId] = useState(""),
    [name, setName] = useState(""),
    [members, setMembers] = useState<string[]>([]),
    [messages, setMessages] = useState<any[]>([]),
    [before, setBefore] = useState<string | null>(null);
  const activeId = useRef(id);
  const latestMessages = useRef(messages);
  activeId.current = id;
  latestMessages.current = messages;
  async function load(older = false, replace = false) {
    if (!id) return;
    const startedId = id;
    const after = !older && !replace ? latestMessages.current.at(-1)?.id : null;
    const data = await apiJson(
      api +
        "/conversations/" +
        id +
        "/messages" +
        (older && before
          ? "?before=" + before
          : after
            ? "?after=" + after
            : ""),
    );
    if (activeId.current !== startedId) return;
    setMessages((old) => {
      const combined = older
        ? [...data.items, ...old]
        : after
          ? [...old, ...data.items]
          : data.items;
      return [
        ...new Map(combined.map((item: any) => [item.id, item])).values(),
      ];
    });
    if (!after) setBefore(data.next);
  }
  useEffect(() => {
    setMessages([]);
    latestMessages.current = [];
    setBefore(null);
    if (!id) return;
    let active = true;
    const pull = () => {
      if (active && document.visibilityState === "visible")
        void run(() => load());
    };
    pull();
    const timer = setInterval(pull, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, revision]);
  return (
    <>
      <h2>Приватні та групові розмови</h2>
      <details className="community-card">
        <summary>Створити розмову</summary>
        <input
          aria-label="Назва розмови"
          placeholder="Назва групи або розмови"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        {friends.data?.people
          ?.filter((f: any) => f.accepted)
          .map((f: any) => (
            <label className="community-task" key={f.id}>
              <input
                type="checkbox"
                checked={members.includes(f.id)}
                onChange={() =>
                  setMembers((old) =>
                    old.includes(f.id)
                      ? old.filter((v) => v !== f.id)
                      : [...old, f.id],
                  )
                }
              />
              {f.displayName}
            </label>
          ))}
        <button
          type="button"
          disabled={!members.length}
          onClick={() =>
            void run(async () => {
              const d = await post(api + "/conversations", {
                title: name || "Розмова",
                members,
              });
              setId(d.id);
              list.refresh();
              setMembers([]);
            })
          }
        >
          Створити
        </button>
      </details>
      <div className="community-chat-layout">
        <aside>
          {list.error && <p>{list.error}</p>}
          {list.data?.items?.map((c: any) => (
            <button
              type="button"
              key={c.id}
              aria-pressed={id === c.id}
              onClick={() => setId(c.id)}
            >
              {c.is_group ? "Група" : "Діалог"} · {c.title}
            </button>
          ))}
        </aside>
        <div>
          {id ? (
            <>
              {before && (
                <button
                  type="button"
                  onClick={() => void run(() => load(true))}
                >
                  Раніші повідомлення
                </button>
              )}
              {messages.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  onChart={onChart}
                  onPick={onPick}
                  run={run}
                  refresh={() => void load(false, true)}
                />
              ))}
              <Composer
                key={id}
                target={{ kind: "message", conversationId: id }}
                onPick={onPick}
                onSent={() => void load()}
                run={run}
              />
            </>
          ) : (
            <div className="community-empty">
              Виберіть розмову або створіть нову.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Trades({ run, owner }: { run: Run; owner?: string }) {
  const resource = useResource("trades:" + owner, () =>
    apiJson(api + "/trades" + (owner ? "?owner=" + owner : "")),
  );
  const [more, setMore] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    setMore([]);
    setNext(resource.data?.next ?? null);
  }, [resource.data]);
  const [selected, setSelected] = useState<any>(null),
    [reason, setReason] = useState(""),
    [review, setReview] = useState("");
  return (
    <>
      <h2>Угоди та статистика</h2>
      <p className="community-hint">
        Реальна API-історія відокремлена від Replay. Метрики першого конектора
        стосуються закритих ордерів Bybit; це не дохідність всього рахунка.
        Нотатки — твердження автора з часом збереження.
      </p>
      {resource.error && <p role="status">{resource.error}</p>}
      {resource.data && (
        <>
          <p>{resource.data.method}</p>
          <div className="community-stats">
            {Object.entries(resource.data.summary ?? {}).map(
              ([currency, v]: [string, any]) => (
                <div className="community-card" key={currency}>
                  <h3>{currency}</h3>
                  <b>{v.pnl ?? "Суми приховані"}</b>
                  <p>
                    Виграшні: {v.wins} · збиткові: {v.losses} · беззбиткові:{" "}
                    {v.flat}
                  </p>
                  <p>
                    Win rate:{" "}
                    {v.winRate === null
                      ? "Недостатньо даних"
                      : v.winRate.toFixed(1) + "%"}
                  </p>
                </div>
              ),
            )}
          </div>
          {!resource.data.items.length && (
            <div className="community-empty">
              Підключіть підтримуваний читальний ключ у налаштуваннях. Ручні
              числа не отримають статус API-підтвердження.
            </div>
          )}
          {[...resource.data.items, ...more].map((trade: any, i: number) => (
            <article className="community-card" key={trade.source_id ?? i}>
              <header>
                <h3>{trade.symbol}</h3>
                <small>
                  {new Date(trade.closed_at).toLocaleString("uk-UA")}
                </small>
              </header>
              <p>
                Вхід: {trade.entry} · Вихід: {trade.exit} · PnL:{" "}
                {trade.pnl ?? "Приховано"} {trade.currency}
              </p>
              <p>{trade.notes?.reason}</p>
              {trade.source_id && (
                <button
                  type="button"
                  onClick={() => {
                    setSelected(trade);
                    setReason(trade.notes?.reason ?? "");
                    setReview(trade.notes?.review ?? "");
                  }}
                >
                  Причина входу й підсумок
                </button>
              )}
            </article>
          ))}
        </>
      )}
      {next && (
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              const d = await apiJson(
                api +
                  "/trades?" +
                  new URLSearchParams({
                    before: next,
                    ...(owner ? { owner } : {}),
                  }),
              );
              setMore((old) => [...old, ...d.items]);
              setNext(d.next);
            })
          }
        >
          Раніші угоди
        </button>
      )}
      {resource.data?.coverage?.map((c: any, i: number) => (
        <p className="community-hint" key={i}>
          Стан джерела: {c.status} · покриття від{" "}
          {c.covered_from
            ? new Date(c.covered_from).toLocaleString("uk-UA")
            : "невідомо"}{" "}
          · оновлено{" "}
          {c.synced_at
            ? new Date(c.synced_at).toLocaleString("uk-UA")
            : "ще не синхронізовано"}
        </p>
      ))}
      {selected && (
        <form
          className="community-card community-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await post(api + "/trades/notes", {
                connectionId: selected.connection_id,
                sourceId: selected.source_id,
                reason,
                review,
              });
              setSelected(null);
              resource.refresh();
            });
          }}
        >
          <h3>{selected.symbol}: нотатки після факту</h3>
          <textarea
            aria-label="Причина входу"
            placeholder="Чому ви відкрили угоду?"
            value={reason}
            maxLength={5000}
            onChange={(e) => setReason(e.target.value)}
          />
          <textarea
            aria-label="Підсумок угоди"
            placeholder="Що виконано і що змінити?"
            value={review}
            maxLength={5000}
            onChange={(e) => setReview(e.target.value)}
          />
          <button>Зберегти нотатки</button>
        </form>
      )}
    </>
  );
}

function Profile({
  id,
  onChart,
  onPick,
  run,
}: {
  id: string;
  onChart: (item: any, target?: Target) => Promise<void>;
  onPick: (t: Target) => void;
  run: Run;
}) {
  const { user, profile, updateProfileData } = useAuth();
  const resource = useResource("profile:" + id, () =>
    apiJson(api + "/profiles/" + id),
  );
  const [showTrades, setShowTrades] = useState(false);
  const [form, setForm] = useState<any>({ ...profile?.community }),
    [displayName, setName] = useState(profile?.displayName ?? "");
  const wall = useResource("wall:" + id, () =>
    apiJson(api + "/feed?mode=wall&owner=" + id),
  );
  const p = resource.data?.profile;
  return (
    <>
      <h2>{p?.displayName ?? "Профіль"}</h2>
      {resource.error && <p>{resource.error}</p>}
      {p && (
        <article className="community-card">
          {p.publicUrl && <p><a href={p.publicUrl} target="_blank" rel="noopener noreferrer">Персональна сторінка ↗</a></p>}
          <p>{p.bio}</p>
          {p.status && <p>{p.status.text}</p>}
          <p>{p.interests}</p>
          <p>{p.lifestyle}</p>
          <p>Досягнення участі: {p.points} · це не торговий рейтинг</p>
          {p.telegram &&
            /^https:\/\/t\.me\/[A-Za-z0-9_]+$/.test(p.telegram) && (
              <a href={p.telegram} target="_blank" rel="noopener noreferrer">
                Telegram-канал ↗
              </a>
            )}
        </article>
      )}
      {id === user?.uid && (
        <form
          className="community-card community-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const { publicProfileEnabled: _publicVisibility, ...fields } = form;
              await updateProfileData({ displayName, community: fields });
              resource.refresh();
            });
          }}
        >
          <h3>Що можуть бачити інші</h3>
          <label>
            Псевдонім
            <input
              value={displayName ?? ""}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {(
            [
              ["bio", "Про себе"],
              ["interests", "Інтереси"],
              ["lifestyle", "Звички й спосіб життя"],
              ["telegram", "Telegram-канал"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <textarea
                value={form[key] ?? ""}
                maxLength={2000}
                onChange={(e) =>
                  setForm((f: any) => ({ ...f, [key]: e.target.value }))
                }
              />
              <Audience
                value={
                  form[key + "Audience"] ??
                  (key === "bio" ? "public" : "private")
                }
                onChange={(value) =>
                  setForm((f: any) => ({ ...f, [key + "Audience"]: value }))
                }
              />
            </label>
          ))}
          <label>
            Мій статус
            <input
              value={form.status?.text ?? ""}
              placeholder="Аналізую 🔎 — сьогодні працюю за планом"
              maxLength={280}
              onChange={(e) =>
                setForm((f: any) => ({
                  ...f,
                  status: { ...f.status, text: e.target.value },
                }))
              }
            />
            <Audience
              value={form.status?.audience ?? "private"}
              onChange={(audience) =>
                setForm((f: any) => ({
                  ...f,
                  status: { ...f.status, audience },
                }))
              }
            />
          </label>
          <p className="community-hint">
            Особистий стан — ваш самоопис, не психологічний діагноз або доказ
            надійності. Не вказуйте адресу й точний побутовий розклад.
          </p>
          <button className="community-primary">Зберегти профіль</button>
        </form>
      )}
      <button type="button" onClick={() => setShowTrades((v) => !v)}>
        Угоди та статистика цього профілю
      </button>
      {id === user?.uid && <PublicProfileSettings />}
      {showTrades && <Trades owner={id} run={run} />}
      <h3>Стіна</h3>
      {id === user?.uid && (
        <Composer
          target={{ kind: "post" }}
          onPick={onPick}
          onSent={wall.refresh}
          run={run}
        />
      )}
      {wall.data?.items
        ?.filter((item: any) => item.owner_id === id)
        .map((item: any) => (
          <ItemCard
            key={item.id}
            item={item}
            onChart={onChart}
            onPick={onPick}
            run={run}
            refresh={wall.refresh}
          />
        ))}
    </>
  );
}

function CommunitySettings({ run }: { run: Run }) {
  const { profile, updateProfileData } = useAuth();
  const connections = useResource("connections", () =>
      apiJson(api + "/connections"),
    ),
    risk = useResource("risk", () => apiJson(api + "/risk")),
    notifications = useResource("notifications", () =>
      apiJson(api + "/notifications"),
    );
  const [key, setKey] = useState(""),
    [apiSecret, setApiSecret] = useState(""),
    [limits, setLimits] = useState<any>({
      hourly: "",
      daily: "",
      monthly: "",
      currency: "USDT",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  useEffect(() => {
    if (risk.data?.risk?.rule) setLimits(risk.data.risk.rule);
  }, [risk.data]);
  const savePrivacy = (key: string, value: string) =>
    run(() =>
      updateProfileData({ community: { ...profile?.community, [key]: value } }),
    );
  return (
    <>
      <h2>Захист, біржі та особисті межі</h2>
      <section className="community-card">
        <h3>Прозорість</h3>
        <p>
          Підтверджені біржові факти не редагуються користувачем. Джерело та
          охоплення показуються окремо; бейдж не означає, що автору можна
          передавати гроші або секрети.
        </p>
        <p>
          Ключ застосовується для читання. Надмірні права відхиляються.
          Read-only сервіс не закриває позиції й не може зупинити торгівлю на
          біржі. Підтримка не просить ключі в чатах, пароль біржі чи seed
          phrase.
        </p>
      </section>
      <AccountSecuritySettings />
      <section className="community-card community-form">
        <h3>Біржі та API · Bybit Global / linear</h3>
        <p>
          Перший конектор читає закриті ордери реального рахунка. EU та інші
          непідтримувані типи ключів не обходяться альтернативними адресами.
        </p>
        <ol>
          <li>На біржі створіть окремий ключ для h00k.</li>
          <li>
            Виберіть тільки читання. Не дозволяйте торгівлю, перекази або
            виведення.
          </li>
          <li>
            Укажіть IP сервісу, наданий адміністратором. Не підключайте ключ,
            доки цей крок не налаштований.
          </li>
          <li>
            Підтвердіть email і 2FA h00k, введіть ключ і секрет лише в цій
            формі.
          </li>
          <li>
            Перевірте охоплення імпорту. Ключ можна відкликати на біржі
            будь-коли.
          </li>
        </ol>
        <a
          href="https://bybit-exchange.github.io/docs/v5/user/apikey-info"
          target="_blank"
          rel="noreferrer"
        >
          Офіційне пояснення дозволів Bybit ↗
        </a>
        <input
          aria-label="API-ключ Bybit"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="API-ключ"
        />
        <input
          aria-label="API-секрет Bybit"
          type="password"
          autoComplete="new-password"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          placeholder="Секрет"
        />
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              await post(api + "/connections", { key, secret: apiSecret });
              setKey("");
              setApiSecret("");
              connections.refresh();
            })
          }
        >
          Перевірити читальні права й підключити
        </button>
        {connections.error && <p>{connections.error}</p>}
        {connections.data?.items?.map((c: any) => (
          <div key={c.id}>
            <b>
              {c.exchange} · {c.status}
            </b>
            <p>
              Дані:{" "}
              {c.synced_at
                ? new Date(c.synced_at).toLocaleString("uk-UA")
                : "ще не синхронізовано"}{" "}
              · покриття від{" "}
              {c.covered_from
                ? new Date(c.covered_from).toLocaleDateString("uk-UA")
                : "невідомо"}
            </p>
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await post(api + "/connections/" + c.id + "/sync", {});
                  connections.refresh();
                  risk.refresh();
                })
              }
            >
              Синхронізувати
            </button>
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  await apiJson(api + "/connections/" + c.id, {
                    method: "DELETE",
                  });
                  connections.refresh();
                })
              }
            >
              Видалити ключ із h00k
            </button>
          </div>
        ))}
      </section>
      <form
        className="community-card community-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await post(api + "/risk", limits);
            risk.refresh();
            notifications.refresh();
          });
        }}
      >
        <h3>Ліміти суми збиткових закриттів</h3>
        <p>
          Прибуткові закриття не компенсують використаний ліміт. Ураховуються
          придатні імпортовані дані. Сповіщення не є блокуванням біржі.
        </p>
        <div className="community-fields">
          {[
            ["hourly", "За останні 60 хвилин"],
            ["daily", "За місцевий день"],
            ["monthly", "За календарний місяць"],
          ].map(([field, label]) => (
            <label key={field}>
              {label}
              <input
                type="number"
                step="any"
                min="0"
                value={limits[field] ?? ""}
                onChange={(e) =>
                  setLimits((s: any) => ({ ...s, [field]: e.target.value }))
                }
              />
            </label>
          ))}
        </div>
        <label>
          Часова зона
          <input
            value={limits.timezone}
            onChange={(e) =>
              setLimits((s: any) => ({ ...s, timezone: e.target.value }))
            }
          />
        </label>
        <select
          aria-label="Валюта ліміту"
          value={limits.currency}
          onChange={(e) =>
            setLimits((s: any) => ({ ...s, currency: e.target.value }))
          }
        >
          <option>USDT</option>
          <option>USDC</option>
        </select>
        <button className="community-primary">Зберегти правила</button>
        {risk.error && <p>{risk.error}</p>}
        {Object.entries(risk.data?.risk?.windows ?? {}).map(
          ([name, w]: [string, any]) => (
            <p key={name}>
              {name}: {w.used} / {w.limit ?? "не задано"} {limits.currency} ·{" "}
              {w.complete
                ? "повне актуальне покриття"
                : "дані неповні або оновлення затримане"}
            </p>
          ),
        )}
      </form>
      <section className="community-card">
        <h3>Фінансова приватність</h3>
        {[
          ["statisticsAudience", "Загальні показники"],
          ["tradesAudience", "Список угод"],
          ["amountsAudience", "Суми й обсяги"],
          ["notesAudience", "Причини входу й нотатки"],
        ].map(([field, label]) => (
          <label className="community-privacy-row" key={field}>
            {label}
            <Audience
              value={(profile?.community as any)?.[field] ?? "private"}
              onChange={(value) => void savePrivacy(field, value)}
            />
          </label>
        ))}
      </section>
      <Rankings run={run} />
      <section className="community-card">
        <h3>Особисті сповіщення</h3>
        {notifications.data?.items?.map((n: any) => (
          <p key={n.id}>
            {new Date(n.created_at).toLocaleString("uk-UA")} ·{" "}
            {n.type === "risk"
              ? `Досягнуто ліміт ${n.body.window}: ${n.body.used} / ${n.body.limit} ${n.body.currency}`
              : (n.body?.text ?? n.type)}
          </p>
        ))}
        {!notifications.data?.items?.length && <p>Сповіщень поки немає.</p>}
      </section>
    </>
  );
}

function Rankings({ run }: { run: Run }) {
  const { profile, updateProfileData } = useAuth();
  const resource = useResource("rankings", () => apiJson(api + "/rankings"));
  return (
    <section className="community-card">
      <h3>Рейтинг за win rate закриттів</h3>
      <p>{resource.data?.method}</p>
      <p>
        Участь добровільна. Абсолютні суми й капітал у таблицю не потрапляють.
        Показник не засвідчує дохідність або надійність особистих пропозицій
        автора.
      </p>
      <label className="community-task">
        <input
          type="checkbox"
          checked={profile?.community?.rankingPublic === true}
          onChange={(e) => {
            const rankingPublic = e.target.checked;
            void run(async () => {
              await updateProfileData({
                community: { ...profile?.community, rankingPublic },
              });
              resource.refresh();
            });
          }}
        />
        Брати участь у публічному порівнянні
      </label>
      {resource.data?.items?.map((r: any, i: number) => (
        <p key={r.id}>
          {i + 1}. {r.name} · {r.count} закриттів ·{" "}
          {r.winRate === null ? "—" : r.winRate.toFixed(1) + "%"}
        </p>
      ))}
      {!resource.data?.items?.length && (
        <p>
          Ще немає учасників із достатньою підтвердженою історією поточного
          періоду.
        </p>
      )}
    </section>
  );
}
