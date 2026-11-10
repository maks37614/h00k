import React, { lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../context/AuthContext";
import { ArchiveProvider } from "../context/ArchiveContext";
import { AuthModal } from "../components/AuthModal";
import "../index.css";
import "../components/community/community.css";

const Community = lazy(() => import("../components/community/CommunityPage").then(m => ({ default: m.CommunityPage })));
function Workspace() {
  const { user, loading, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const resetting = new URLSearchParams(location.search).has("reset");
  return <main className="community-shell" data-network-mode="community-only">
    <header className="community-card" style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <b>h00k Community</b><a href="https://h00k.top">Перейти до скрінера ↗</a>
      {user && <button type="button" onClick={() => void logout().catch(e => setError(e.message))}>Вийти</button>}
    </header>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">Перевіряємо сеанс…</p> : user && !resetting ?
      <Suspense fallback={<p role="status">Відкриваємо спільноту…</p>}><Community onReplay={() => { location.href = "https://h00k.top/#replay"; }} /></Suspense> :
      <section className="community-card"><h1>Спільнота трейдерів h00k</h1><p>Власний акаунт, приватність і спільні розбори графіків.</p><button type="button" onClick={() => setOpen(true)}>Увійти або зареєструватися</button></section>}
    <AuthModal isOpen={!loading && (resetting || (!user && open))} onClose={() => setOpen(false)} />
  </main>;
}
createRoot(document.getElementById("community-root")!).render(<AuthProvider><ArchiveProvider><Workspace /></ArchiveProvider></AuthProvider>);
