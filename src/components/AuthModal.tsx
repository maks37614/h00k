import React, { useEffect, useState } from "react";
import { X, ShieldCheck } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { apiJson } from "../utils/apiFetch";
export type AuthPromptReason =
  "chart" | "alerts" | "linking" | "general" | null;
interface Props {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: "signin" | "signup";
  onSuccess?: () => void;
  isRestrictedMode?: boolean;
  promptReason?: AuthPromptReason;
}
export const AuthModal: React.FC<Props> = ({
  isOpen,
  onClose,
  initialMode = "signin",
  onSuccess,
  isRestrictedMode,
}) => {
  const { signInWithEmail, registerWithEmail, clearSession } = useAuth();
  const [mode, setMode] = useState(initialMode),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [code, setCode] = useState(""),
    [recoveryMode, setRecoveryMode] = useState(false),
    [recoveryCode, setRecoveryCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const reset =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("reset")
      : null;
  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setError("");
    } else {
      setPassword("");
      setCode("");
      setRecoveryCode("");
      setRecoveryMode(false);
    }
  }, [isOpen, initialMode]);
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] bg-slate-950/90 flex items-center justify-center p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Акаунт h00k"
        className="w-full max-w-md border border-slate-700 rounded-2xl bg-slate-900 p-6 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">
            {reset
              ? "Новий пароль"
              : mode === "signup"
                ? "Реєстрація h00k"
                : "Вхід у h00k"}
          </h2>
          {!isRestrictedMode && (
            <button type="button" aria-label="Закрити" onClick={onClose}>
              <X />
            </button>
          )}
        </div>
        <p className="text-sm text-slate-400 flex gap-2">
          <ShieldCheck size={18} />
          Власний акаунт h00k. Фінансові дані приватні, доки ви не виберете іншу
          аудиторію.
        </p>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              if (reset) {
                await apiJson("/api/account/reset", {
                  method: "POST",
                  body: JSON.stringify({
                    token: reset,
                    password,
                    ...(recoveryMode ? { recoveryCode } : { code }),
                  }),
                });
                clearSession();
                setPassword("");
                setCode("");
                setRecoveryCode("");
                history.replaceState({}, "", location.pathname);
                setError("Пароль змінено. Увійдіть знову.");
              } else if (mode === "signup")
                await registerWithEmail(email, password, name);
              else
                await signInWithEmail(
                  email,
                  password,
                  recoveryMode ? undefined : code,
                  recoveryMode ? recoveryCode : undefined,
                );
              if (!reset) {
                onSuccess?.();
                onClose();
              }
            } catch (err) {
              setError(
                err instanceof Error
                  ? err.message
                  : "Не вдалося виконати запит",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {mode === "signup" && !reset && (
            <input
              className="w-full bg-slate-950 rounded-lg p-3"
              placeholder="Ім’я або псевдонім"
              aria-label="Ім’я"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          {!reset && (
            <input
              className="w-full bg-slate-950 rounded-lg p-3"
              type="email"
              autoComplete="email"
              placeholder="Email"
              aria-label="Email"
              value={email}
              required
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
          <input
            className="w-full bg-slate-950 rounded-lg p-3"
            type="password"
            autoComplete={
              mode === "signup" || reset ? "new-password" : "current-password"
            }
            placeholder="Пароль"
            aria-label="Пароль"
            minLength={mode === "signup" || reset ? 15 : 1}
            maxLength={256}
            value={password}
            required
            onChange={(e) => setPassword(e.target.value)}
          />
          {(mode !== "signup" || reset) && (
            <>
              <label className="flex gap-2 items-center text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={recoveryMode}
                  onChange={(e) => {
                    setRecoveryMode(e.target.checked);
                    setCode("");
                    setRecoveryCode("");
                  }}
                />
                Використати резервний код 2FA
              </label>
              {recoveryMode ? (
                <input
                  className="w-full bg-slate-950 rounded-lg p-3"
                  autoComplete="off"
                  aria-label="Резервний код 2FA"
                  placeholder="Одноразовий резервний код"
                  value={recoveryCode}
                  maxLength={64}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                />
              ) : (
                <input
                  className="w-full bg-slate-950 rounded-lg p-3"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="Код 2FA, якщо налаштовано"
                  aria-label="Код 2FA"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                />
              )}
            </>
          )}
          {mode === "signup" && (
            <p className="text-xs text-slate-400">
              Щонайменше 15 символів. Реєстрація не підключає біржу й не
              публікує ваші фінанси.
            </p>
          )}
          <button
            disabled={busy}
            className="w-full p-3 rounded-lg bg-cyan-500 text-slate-950 font-bold"
          >
            {busy
              ? "Зачекайте…"
              : reset
                ? "Змінити пароль"
                : mode === "signup"
                  ? "Створити акаунт"
                  : "Увійти"}
          </button>
        </form>
        {error && (
          <p role="status" className="text-sm text-amber-300">
            {error}
          </p>
        )}
        <div className="flex justify-between gap-3 text-sm">
          <button
            type="button"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          >
            {mode === "signin" ? "Створити акаунт" : "Уже є акаунт"}
          </button>
          <button
            type="button"
            disabled={busy || !email}
            onClick={async () => {
              setBusy(true);
              try {
                const d = await apiJson("/api/account/reset/request", {
                  method: "POST",
                  body: JSON.stringify({ email }),
                });
                setError(d.message);
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Не вдалося надіслати",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Відновити доступ
          </button>
        </div>
      </section>
    </div>
  );
};
