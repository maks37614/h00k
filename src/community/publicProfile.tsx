import React, { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChartPreview } from "../components/community/ChartPreview";
import type { ChartDocument } from "./chartDocument";
import "./publicProfile.css";

const HookChart = lazy(() => import("../components/community/SharedHookChart"));
async function read(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { credentials: "omit", cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || "Профіль недоступний");
  return data;
}
function nameAtLocation() {
  const path = location.pathname.match(/^\/u\/([a-z0-9-]+)\/?$/i);
  return (path?.[1] ?? location.hostname.split(".")[0]).toLowerCase();
}
export function PublicProfile() {
  const [profile, setProfile] = useState<any>(null), [items, setItems] = useState<any[]>([]);
  const [next, setNext] = useState<string | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [chart, setChart] = useState<ChartDocument | null>(null);
  const base = "/api/public/profiles/" + encodeURIComponent(nameAtLocation());
  useEffect(() => { if (chart) document.getElementById("public-chart-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [!!chart]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([read(base, controller.signal), read(base + "/posts", controller.signal)])
      .then(([account, wall]) => { setProfile(account.profile); setItems(wall.items); setNext(wall.next); document.title = account.profile.displayName + " · h00k Community"; })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [base]);
  const more = async () => {
    if (!next || busy) return;
    setBusy(true); setError("");
    try { const page = await read(base + "/posts?before=" + encodeURIComponent(next)); setItems(old => [...old, ...page.items]); setNext(page.next); }
    catch (e) { setError(e instanceof Error ? e.message : "Не вдалося завантажити пости"); }
    finally { setBusy(false); }
  };
  const openChart = async (id: string) => {
    if (busy) return;
    setBusy(true); setError(""); setChart(null);
    try { setChart((await read(base + "/posts/" + id + "/chart")).document); }
    catch (e) { setError(e instanceof Error ? e.message : "Графік недоступний"); }
    finally { setBusy(false); }
  };
  const communityUrl = profile ? profile.communityOrigin + "/#community?section=profile&owner=" + encodeURIComponent(profile.id) : null;
  return <main className="public-profile" data-network-mode="public-snapshot">
    <header className="public-profile-top"><span className="public-profile-brand">h00k<span>Community</span></span><span>Публічна сторінка трейдера</span></header>
    {error && <p className="public-profile-error" role="alert">{error}</p>}
    {!profile && !error && <p role="status">Завантажуємо профіль…</p>}
    {profile && <>
      <section className="public-profile-hero">
        <div className="public-profile-avatar" aria-hidden="true">{profile.displayName.slice(0, 1).toUpperCase()}</div>
        <div><p className="public-profile-handle">@{profile.username}</p><h1>{profile.displayName}</h1>{profile.status && <p>{profile.status}</p>}</div>
        <a className="public-profile-action" href={communityUrl!}>Відкрити у Community ↗</a>
      </section>
      {profile.bio && <section className="public-profile-panel"><h2>Про себе</h2><p>{profile.bio}</p></section>}
      {(profile.interests || profile.lifestyle || profile.telegram) && <section className="public-profile-panel">
        {profile.interests && <><h2>Інтереси</h2><p>{profile.interests}</p></>}
        {profile.lifestyle && <><h2>Звички та спосіб життя</h2><p>{profile.lifestyle}</p></>}
        {profile.telegram && <a href={profile.telegram} target="_blank" rel="noopener noreferrer">Telegram-канал ↗</a>}
      </section>}
      {profile.statistics && <section className="public-profile-panel"><h2>Статистика з API</h2>
        <p className="public-profile-muted">Bybit linear · імпортовані закриті ордери. Не повна дохідність рахунку. Беззбиткові закриття не входять у знаменник win rate.</p>
        {profile.statistics.totals.map((s: any) => <div className="public-profile-stats" key={s.currency}>
          <span><b>{s.count}</b> закриттів · {s.currency}</span><span><b>{s.winRate === null ? "—" : s.winRate.toFixed(1) + "%"}</b> win rate</span>
          <span>{s.wins} прибуткових · {s.losses} збиткових · {s.flat} беззбиткових</span>
          {s.pnl !== undefined && <span>Сумарний PnL: {s.pnl} {s.currency}</span>}
        </div>)}
        {!profile.statistics.totals.length && <p>Імпортованих закриттів ще немає.</p>}
        {profile.statistics.coverage.map((c: any, i: number) => <p className="public-profile-muted" key={i}>
          Стан: {c.status} · остання синхронізація: {c.synced_at ? new Date(c.synced_at).toLocaleString("uk-UA") : "ще не виконана"}
          {c.covered_from && " · початок покриття: " + new Date(c.covered_from).toLocaleDateString("uk-UA")}
        </p>)}
      </section>}
      <section aria-label="Публічна стіна"><h2>Публікації</h2>
        {items.map(item => <article className="public-profile-panel" key={item.id}>
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("uk-UA")}</time>
          {item.title && <h3>{item.title}</h3>}<p>{item.text}</p>
          <div className="public-profile-photos">{item.photos.map((id: string) => <img key={id} loading="lazy" alt="Фото до публікації" src={`${base}/posts/${item.id}/media/${id}`} />)}</div>
          {item.chart && <ChartPreview document={item.chart} onOpen={() => void openChart(item.id)} />}
          <a href={communityUrl!}>Обговорити у Community ↗</a>
        </article>)}
        {!items.length && <p className="public-profile-muted">Публічних публікацій поки немає.</p>}
        {next && <button type="button" disabled={busy} onClick={() => void more()}>Ще публікації</button>}
      </section>
      {chart && <section id="public-chart-workspace" className="public-profile-panel public-profile-workspace" aria-label="Збережений HookChart">
        <div className="public-profile-workspace-heading"><h2>HookChart · власний розбір</h2><button type="button" onClick={() => setChart(null)}>Закрити графік</button></div>
        <p>Зміни локальні й не змінюють публікацію. Доступні свічки збереженого знімка; біржових підключень немає. Для публікації відповіді відкрийте оригінал у Community.</p>
        <Suspense fallback={<p role="status">Відкриваємо HookChart…</p>}><HookChart value={chart} onChange={setChart} /></Suspense>
      </section>}
    </>}
    <footer className="public-profile-muted">Власник обирає публічні дані. Торгова статистика не гарантує надійність людини. Нікому не передавайте паролі, API-ключі або кошти.</footer>
  </main>;
}
if (typeof document !== "undefined" && document.getElementById("profile-root"))
  createRoot(document.getElementById("profile-root")!).render(<PublicProfile />);
