import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { apiJson } from "../../utils/apiFetch";
const post = (url: string, body: unknown) =>
  apiJson("/api/account" + url, { method: "POST", body: JSON.stringify(body) });

function eraseLocalAccountData(id: string) {
  try {
    const suffixes = ["_" + id, ":" + id];
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of Object.keys(storage))
        if (suffixes.some((suffix) => key.endsWith(suffix)))
          storage.removeItem(key);
    }
  } catch {}
}
function downloadRecovery(codes: string[]) {
  const blob = new Blob(
    [
      "h00k — одноразові резервні коди 2FA\nЗберігайте окремо від пароля. Кожен код працює один раз.\n\n" +
        codes.join("\n"),
    ],
    { type: "text/plain;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = "h00k-recovery-codes.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function AccountSecuritySettings() {
  const { user, clearSession } = useAuth();
  const [security, setSecurity] = useState<any>(null),
    [sessions, setSessions] = useState<any[]>([]),
    [notice, setNotice] = useState("");
  const [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [recovery, setRecovery] = useState(false),
    [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState(""),
    [enrollmentCode, setEnrollmentCode] = useState(""),
    [codes, setCodes] = useState<string[]>([]),
    [savedCodes, setSavedCodes] = useState(false);
  const [newPassword, setNewPassword] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [confirmation, setConfirmation] = useState("");
  const pending = useRef(false),
    mounted = useRef(true),
    verification = useRef(false);
  const credentials = () => ({
    password,
    ...(recovery ? { recoveryCode: code } : { code }),
  });
  const clearCredentials = () => {
    setPassword("");
    setCode("");
  };
  const load = async () => {
    const [account, devices] = await Promise.all([
      apiJson("/api/account/me"),
      apiJson("/api/account/sessions"),
    ]);
    if (mounted.current) {
      setSecurity(account.security);
      setSessions(devices.items);
    }
  };
  async function act(fn: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (error) {
      if (mounted.current)
        setNotice(
          error instanceof Error ? error.message : "Не вдалося виконати дію",
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (!verification.current) {
      verification.current = true;
      void act(async () => {
        const token = new URLSearchParams(location.search).get("verify");
        if (token) {
          await post("/verify", { token });
          history.replaceState({}, "", location.pathname + location.hash);
          setNotice("Email за посиланням підтверджено.");
        }
        await load();
      });
    }
    return () => {
      mounted.current = false;
    };
  }, []);
  const protectedAction = async (
    path: string,
    extra: Record<string, unknown> = {},
  ) => {
    const result = await post(path, { ...credentials(), ...extra });
    clearCredentials();
    return result;
  };
  return (
    <>
      <section
        className="community-card community-form"
        aria-label="Захист акаунта"
      >
        <h3>Безпека власного акаунта</h3>
        {notice && <p role="status">{notice}</p>}
        <p>
          Email: {security?.emailVerified ? "підтверджено" : "не підтверджено"}{" "}
          · 2FA: {security?.mfaEnabled ? "увімкнено" : "не налаштовано"}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await post("/verify/request", {});
              setNotice("Запит на підтвердження email прийнято.");
            })
          }
        >
          Надіслати підтвердження email
        </button>
        <p>
          Для змін безпеки, експорту й видалення підтвердьте поточний пароль та
          налаштований другий фактор. Кожен код використовується один раз.
        </p>
        <label>
          Поточний пароль
          <input
            type="password"
            autoComplete="current-password"
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {security?.mfaEnabled && (
          <>
            <label>
              <input
                type="checkbox"
                checked={recovery}
                onChange={(e) => {
                  setRecovery(e.target.checked);
                  setCode("");
                }}
              />
              Використати резервний код
            </label>
            <label>
              {recovery ? "Резервний код 2FA" : "Поточний код 2FA"}
              <input
                autoComplete={recovery ? "off" : "one-time-code"}
                inputMode={recovery ? "text" : "numeric"}
                maxLength={recovery ? 64 : 6}
                value={code}
                onChange={(e) =>
                  setCode(
                    recovery
                      ? e.target.value
                      : e.target.value.replace(/\D/g, ""),
                  )
                }
              />
            </label>
            <button
              type="button"
              disabled={busy || !code}
              onClick={() =>
                void act(async () => {
                  await post(
                    "/mfa/check",
                    recovery ? { recoveryCode: code } : { code },
                  );
                  setCode("");
                  await load();
                  setNotice("Другий фактор підтверджено для чутливих дій.");
                })
              }
            >
              Підтвердити другий фактор
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy || !password}
          onClick={() =>
            void act(async () => {
              const d = await protectedAction("/mfa/setup");
              setSecret(d.secret);
              setEnrollmentCode("");
              setCodes([]);
            })
          }
        >
          {security?.mfaEnabled
            ? "Замінити застосунок 2FA"
            : "Налаштувати застосунок 2FA"}
        </button>
        {secret && (
          <div className="community-card community-form">
            <p>
              Додайте секрет до застосунку автентифікації. До підтвердження
              попередній другий фактор продовжує діяти.
            </p>
            <code className="community-security-secret">{secret}</code>
            <label>
              Код із нового застосунку
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                value={enrollmentCode}
                onChange={(e) =>
                  setEnrollmentCode(e.target.value.replace(/\D/g, ""))
                }
              />
            </label>
            <button
              type="button"
              disabled={busy || enrollmentCode.length !== 6}
              onClick={() =>
                void act(async () => {
                  const d = await post("/mfa/confirm", {
                    code: enrollmentCode,
                  });
                  setCodes(d.recoveryCodes);
                  setSavedCodes(false);
                  setSecret("");
                  setEnrollmentCode("");
                  await load();
                })
              }
            >
              Підтвердити новий другий фактор
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSecret("");
                setEnrollmentCode("");
              }}
            >
              Закрити налаштування
            </button>
          </div>
        )}
        {security?.mfaEnabled && (
          <>
            <p>
              Невикористаних резервних кодів:{" "}
              {security.recoveryCodesRemaining ?? "…"}. Підтримка не просить їх
              у чатах.
            </p>
            <button
              type="button"
              disabled={busy || !password || !code}
              onClick={() =>
                void act(async () => {
                  const d = await protectedAction("/mfa/recovery-codes");
                  setCodes(d.recoveryCodes);
                  setSavedCodes(false);
                  await load();
                })
              }
            >
              Створити новий набір резервних кодів
            </button>
            <button
              type="button"
              disabled={busy || !password || !code}
              onClick={() =>
                void act(async () => {
                  await protectedAction("/mfa/disable");
                  setCodes([]);
                  setSecret("");
                  await load();
                  setNotice(
                    "2FA вимкнено. Інші сеанси й резервні коди відкликано.",
                  );
                })
              }
            >
              Вимкнути 2FA
            </button>
          </>
        )}
        {!!codes.length && (
          <div
            className="community-card community-form"
            aria-label="Нові резервні коди"
          >
            <h4>Збережіть ці коди зараз</h4>
            <p>
              Після закриття вони не показуватимуться знову. Попередній набір
              уже не діє. Зберігайте окремо від пароля; кожен код працює один
              раз.
            </p>
            <pre className="community-recovery-codes">{codes.join("\n")}</pre>
            <button type="button" onClick={() => downloadRecovery(codes)}>
              Завантажити коди
            </button>
            <label>
              <input
                type="checkbox"
                checked={savedCodes}
                onChange={(e) => setSavedCodes(e.target.checked)}
              />
              Я зберіг резервні коди
            </label>
            <button
              type="button"
              disabled={!savedCodes}
              onClick={() => setCodes([])}
            >
              Приховати коди
            </button>
          </div>
        )}
        <label>
          Новий пароль
          <input
            type="password"
            autoComplete="new-password"
            minLength={15}
            maxLength={256}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || !password || newPassword.length < 15}
          onClick={() =>
            void act(async () => {
              await protectedAction("/password", { newPassword });
              setNewPassword("");
              await load();
              setNotice("Пароль змінено, інші сеанси відкликано.");
            })
          }
        >
          Змінити пароль
        </button>
        <h4>Сеанси входу</h4>
        {sessions.map((session) => (
          <div className="community-session-row" key={session.id}>
            <span>
              {session.current ? "Цей сеанс" : "Інший сеанс"} ·{" "}
              {new Date(session.created_at).toLocaleString("uk-UA")}
            </span>
            {!session.current && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await apiJson("/api/account/sessions/" + session.id, {
                      method: "DELETE",
                    });
                    await load();
                  })
                }
              >
                Завершити
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await post("/logout-all", {});
              clearSession();
            })
          }
        >
          Вийти на всіх пристроях
        </button>
      </section>
      <section
        className="community-card community-form"
        aria-label="Власні дані"
      >
        <h3>Копія ваших даних</h3>
        <p>
          Завантаження JSONL.gz включає ваші записи й зображення. Паролі, токени
          сеансів, секрети 2FA та ключі бірж до файлу не потрапляють. Дані
          Community та скрінера завантажуються окремо.
        </p>
        {(["community", "market"] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            disabled={busy || !password}
            onClick={() =>
              void act(async () => {
                const d = await protectedAction("/export", { scope });
                window.location.assign(d.url);
                setNotice(
                  "Завантаження розпочато. Для другого файлу підтвердьте пароль і, якщо налаштовано, новий код 2FA.",
                );
              })
            }
          >
            {scope === "community"
              ? "Завантажити дані Community"
              : "Завантажити дані скрінера й Telegram"}
          </button>
        ))}
        <h3>Видалення акаунта</h3>
        {!preview ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setPreview(await apiJson("/api/account/delete/preview"));
              })
            }
          >
            Переглянути, що буде видалено
          </button>
        ) : (
          <div className="community-card community-form community-account-deletion">
            <p>
              Буде видалено ваших матеріалів: {preview.counts.items}, формацій:{" "}
              {preview.counts.archives}, угод: {preview.counts.trades}, фото:{" "}
              {preview.counts.media}. Сеанси завершуються, а API-ключі
              стираються зі сховища h00k одразу. Сам ключ на біржі потрібно
              відкликати самостійно.
            </p>
            <p>
              Розмов із передаванням власності: {preview.counts.groups}.
              Власником стане найдавніший адміністратор або учасник. Ваші
              повідомлення й розмітки видаляються; залежні відповіді втратять
              доступ до джерела.
            </p>
            <p>
              Файли фото, сповіщення, спостереження й прив’язка Telegram
              очищуються фоновою чергою. Ця дія не стирає вже завантажені іншими
              людьми копії та доставлені повідомлення Telegram. Дані в резервних
              копіях можуть зберігатися до завершення їхнього строку зберігання.
            </p>
            <p>
              Спершу завантажте потрібні дані. Відновити цей акаунт через форму
              входу буде неможливо.
            </p>
            <label>
              Для підтвердження введіть DELETE
              <input
                autoComplete="off"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !password || confirmation !== "DELETE"}
              onClick={() =>
                void act(async () => {
                  await protectedAction("/delete", { confirm: confirmation });
                  if (user) eraseLocalAccountData(user.uid);
                  clearSession();
                  window.dispatchEvent(new Event("h00k:account-deleted"));
                  location.hash = "screener";
                })
              }
            >
              Видалити мій акаунт і дані
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setConfirmation("");
              }}
            >
              Скасувати
            </button>
          </div>
        )}
      </section>
    </>
  );
}
