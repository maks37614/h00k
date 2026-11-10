import React, { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { apiJson } from "../../utils/apiFetch";

export function PublicProfileSettings() {
  const { user, profile, updateProfileData } = useAuth();
  const [info, setInfo] = useState<any>(null), [name, setName] = useState("");
  const [password, setPassword] = useState(""), [code, setCode] = useState(""), [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true;
    void apiJson("/api/account/username").then(data => { if (alive) { setInfo(data); setName(data.username ?? ""); } })
      .catch(e => { if (alive) setNotice(e.message); });
    return () => { alive = false; };
  }, [user?.uid]);
  const enabled = profile?.community?.publicProfileEnabled === true;
  const verified = info?.emailVerified ?? user?.emailVerified;
  return <section className="community-card community-form" aria-label="Публічна адреса профілю">
    <h3>Персональна адреса h00k</h3>
    <p>3–30 латинських літер, цифр або дефісів. Перша літера, останній символ — літера чи цифра. Службові назви зарезервовані.</p>
    {info?.url && <a href={info.url} target="_blank" rel="noopener noreferrer">{info.url} ↗</a>}
    <p className="community-hint">Зміна адреси — раз на 30 днів. Попередня адреса перестає працювати й не передається іншій людині. Для резервування потрібні підтверджений email, поточний пароль і ваш другий фактор, якщо налаштований.</p>
    <form className="community-form" onSubmit={async e => {
      e.preventDefault(); if (busy) return; setBusy(true); setNotice("");
      try {
        const result = await apiJson("/api/account/username", { method: "POST", body: JSON.stringify({ username: name, password, ...(recovery ? { recoveryCode: code } : { code }) }) });
        setInfo(result); setName(result.username); setNotice("Адресу збережено. Видимість налаштовується окремо.");
      } catch (e) { setNotice(e instanceof Error ? e.message : "Не вдалося зберегти адресу"); }
      finally { setPassword(""); setCode(""); setBusy(false); }
    }}>
      <label>Ім’я в адресі<input value={name} onChange={e => setName(e.target.value)} minLength={3} maxLength={30} autoComplete="username" required /></label>
      <label>Поточний пароль<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></label>
      <label>Код 2FA або резервний код<input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" /></label>
      <label><input type="checkbox" checked={recovery} onChange={e => setRecovery(e.target.checked)} /> Використати одноразовий резервний код</label>
      <button disabled={busy || !verified}>{busy ? "Зберігаємо…" : "Зберегти адресу"}</button>
      {!verified && <p>Підтвердіть email у розділі безпеки акаунта.</p>}
      {info?.changeAllowedAt && <p className="community-hint">Наступна зміна доступна після {new Date(info.changeAllowedAt).toLocaleString("uk-UA")}.</p>}
    </form>
    <label><input type="checkbox" checked={enabled} disabled={busy || !info?.username} onChange={async e => {
      const value = e.target.checked; setBusy(true); setNotice("");
      try { await updateProfileData({ community: { publicProfileEnabled: value } }); }
      catch (e) { setNotice(e instanceof Error ? e.message : "Не вдалося змінити видимість"); }
      finally { setBusy(false); }
    }} /> Дозволити перегляд публічного профілю без входу</label>
    <p className="community-hint">За замовчуванням вимкнено. Увімкнення відкриває публічні пости, їхні фото й розмітку для всього Інтернету. Поля з аудиторією «Друзі» або «Лише я» не показуються. Статистика та суми потребують окремої публічної видимості. Баланс, приватні угоди та нотатки тут не публікуються.</p>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
