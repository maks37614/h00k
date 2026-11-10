import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { apiJson } from "../../utils/apiFetch";
/** One small per-account inbox poll, never per chart and never an exchange request. */
export function CommunityNotifications() {
  const { user } = useAuth();
  const [deleted, setDeleted] = useState(false);
  useEffect(() => {
    const show = () => setDeleted(true);
    window.addEventListener("h00k:account-deleted", show);
    return () => window.removeEventListener("h00k:account-deleted", show);
  }, []);
  useEffect(() => {
    if (user) setDeleted(false);
  }, [user?.uid]);
  const [notice, setNotice] = useState<any>(null),
    epoch = useRef(user?.uid);
  epoch.current = user?.uid;
  useEffect(() => {
    setNotice(null);
    if (!user) return;
    const uid = user.uid;
    let active = true;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const d = await apiJson("/api/community/notifications");
        if (active && epoch.current === uid)
          setNotice(
            d.items.find((n: any) => n.type === "risk" && !n.read_at) ??
              d.items.find((n: any) => n.type === "security" && !n.read_at) ??
              null,
          );
      } catch {}
    };
    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [user?.uid]);
  if (deleted)
    return (
      <aside
        role="status"
        className="fixed bottom-4 right-4 z-[150] max-w-sm rounded-xl border border-cyan-500/50 bg-slate-950 p-4 text-sm text-cyan-100 shadow-xl"
      >
        <b>Акаунт видалено</b>
        <p>
          Доступ закрито, а збережені ключі стерто. Файли й пов’язані дані
          скрінера очищуються у фоні. Ключ на біржі відкличте самостійно.
        </p>
        <button type="button" onClick={() => setDeleted(false)}>
          Зрозуміло
        </button>
      </aside>
    );
  if (!notice) return null;
  return (
    <aside
      role="alert"
      className="fixed bottom-4 right-4 z-[150] max-w-sm rounded-xl border border-amber-500/50 bg-slate-950 p-4 text-sm text-amber-200 shadow-xl"
    >
      <b>
        {notice.type === "risk"
          ? "Досягнуто особистий ліміт збитку"
          : "Подія безпеки акаунта"}
      </b>
      <p>
        {notice.type === "risk"
          ? "Перевірте свій план і свіжість даних. h00k не зупиняє торгівлю на біржі."
          : notice.body?.text}
      </p>
      <div className="mt-3 flex gap-3">
        <a href="#community?section=settings" className="underline">
          Переглянути
        </a>
        <button
          type="button"
          onClick={() => {
            const id = notice.id;
            void apiJson("/api/community/notifications/" + id + "/read", {
              method: "POST",
              body: "{}",
            })
              .then(() => setNotice(null))
              .catch(() => {});
          }}
        >
          Прочитано
        </button>
      </div>
    </aside>
  );
}
