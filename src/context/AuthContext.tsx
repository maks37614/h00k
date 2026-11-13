import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { UserProfile } from '../types';
import { mergeProfileUpdate } from '../utils/hookchartData';
import { getStoredPreferences, saveStoredPreferences } from '../utils/userPreferences';
import { DEFAULT_METASCALP_SETTINGS, saveStoredMetaScalpSettings } from '../utils/metaScalpService';
import { setApiIdentity, apiFetch } from '../utils/apiFetch';

export interface H00kUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  emailVerified: boolean;
}
export interface AuthSessionSummary {
  id: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface AuthContextType {
  user: H00kUser | null;
  profile: UserProfile | null;
  loading: boolean;
  signInWithGoogle: (inviteCode?: string, isSignUp?: boolean) => Promise<void>;
  signInWithEmail: (email: string, password: string, remember?: boolean) => Promise<void>;
  registerWithEmail: (email: string, password: string, name?: string, inviteCode?: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  resetPassword: (password: string) => Promise<void>;
  resetToken: string | null;
  updateProfileData: (updates: Partial<UserProfile>) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  listSessions: () => Promise<AuthSessionSummary[]>;
  revokeSession: (id: string) => Promise<void>;
  authError: string | null;
  authErrorCode: string | null;
  authNotice: string | null;
  clearAuthError: () => void;
}
export const AuthContext = createContext<AuthContextType | undefined>(undefined);

let initialResetToken: string | null = null;
if (typeof window !== 'undefined') {
  const params = new URLSearchParams(window.location.search);
  initialResetToken = params.get('resetPassword');
}

async function authRequest(path: string, body: unknown): Promise<any> {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(data.error || 'Не вдалося виконати запит. Спробуйте пізніше.') as Error & { code?: string };
    error.code = data.code || 'AUTH_ERROR';
    throw error;
  }
  return data;
}
function stripLegacySecrets(profile: UserProfile): UserProfile {
  const clean = { ...profile };
  delete clean.telegramBotToken;
  delete clean.telegramChatId;
  delete clean.telegramBotUsername;
  delete clean.inviteCode;
  return clean;
}
function applySitePreferences(profile: UserProfile, uid: string) {
  saveStoredPreferences({
    ...(profile.defaultExchange ? { defaultExchange: profile.defaultExchange } : {}),
    ...(profile.defaultMarketType ? { defaultMarketType: profile.defaultMarketType } : {}),
    ...(profile.defaultTimeframe ? { defaultTimeframe: profile.defaultTimeframe } : {}),
    ...(profile.soundAlertsEnabled !== undefined ? { soundAlertsEnabled: profile.soundAlertsEnabled } : {}),
  });
  saveStoredMetaScalpSettings(profile.metaScalpSettings || DEFAULT_METASCALP_SETTINGS, uid);
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<H00kUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authErrorCode, setAuthErrorCode] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(initialResetToken);
  const userRef = useRef(user);
  const profileRef = useRef(profile);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  userRef.current = user;
  profileRef.current = profile;

  const setIdentity = useCallback((payload: any) => {
    if (!payload?.user?.uid || !payload.profile || !payload.csrf) throw new Error('Неповні дані сесії.');
    const nextUser = payload.user as H00kUser;
    const nextProfile = stripLegacySecrets(payload.profile as UserProfile);
    setApiIdentity(nextUser.uid, String(payload.csrf));
    userRef.current = nextUser;
    profileRef.current = nextProfile;
    setUser(nextUser);
    setProfile(nextProfile);
    applySitePreferences(nextProfile, nextUser.uid);
  }, []);
  const clearIdentity = useCallback(() => {
    setApiIdentity(null, null);
    userRef.current = null;
    profileRef.current = null;
    setUser(null);
    setProfile(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Do not destroy browser-local user settings during auth bootstrap.
    const params = new URLSearchParams(window.location.search);
    const verifyToken = params.get('verifyEmail');
    if (verifyToken || params.has('resetPassword')) {
      params.delete('verifyEmail');
      params.delete('resetPassword');
      const query = params.toString();
      window.history.replaceState(window.history.state, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
    }
    let cancelled = false;
    const bootstrap = async () => {
      try {
        if (verifyToken) {
          const response = await authRequest('/api/auth/verify-email', { token: verifyToken });
          if (!cancelled) {
            setIdentity(response);
            setAuthNotice('Електронну пошту підтверджено. Ви увійшли до h00k.');
          }
        } else {
          const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
          if (response.ok) {
            const result = await response.json();
            if (!cancelled) setIdentity(result);
          } else if (!cancelled) clearIdentity();
        }
      } catch (error: any) {
        if (!cancelled) {
          clearIdentity();
          setAuthError(error?.message || 'Не вдалося перевірити авторизацію.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void bootstrap();
    return () => { cancelled = true; mounted.current = false; };
  }, [setIdentity, clearIdentity]);

  const handleError = (error: any): never => {
    const text = error?.message || 'Помилка авторизації.';
    setAuthError(text);
    setAuthErrorCode(error?.code || null);
    throw error;
  };
  const clearAuthError = () => {
    setAuthError(null);
    setAuthErrorCode(null);
    setAuthNotice(null);
  };
  const signInWithEmail = async (email: string, pass: string, remember = true) => {
    clearAuthError();
    try { setIdentity(await authRequest('/api/auth/login', { email, password: pass, remember })); }
    catch (error) { handleError(error); }
  };
  const registerWithEmail = async (email: string, pass: string, name?: string) => {
    clearAuthError();
    try {
      await authRequest('/api/auth/register', { email, password: pass, displayName: name });
      setAuthNotice('Акаунт створено. Перевірте email і перейдіть за посиланням підтвердження.');
    } catch (error) { handleError(error); }
  };
  const signInWithGoogle = async () => {
    const error = new Error('Вхід Google тимчасово недоступний. Використайте email і пароль.');
    handleError(error);
  };
  const resendVerification = async (email: string) => {
    clearAuthError();
    try {
      await authRequest('/api/auth/resend-verification', { email });
      setAuthNotice('Якщо адреса зареєстрована, перевірте пошту.');
    } catch (error) { handleError(error); }
  };
  const requestPasswordReset = async (email: string) => {
    clearAuthError();
    try {
      await authRequest('/api/auth/forgot-password', { email });
      setAuthNotice('Якщо такий акаунт існує, ми надіслали посилання для відновлення.');
    } catch (error) { handleError(error); }
  };
  const resetPassword = async (pass: string) => {
    clearAuthError();
    if (!resetToken) return handleError(new Error('Посилання відновлення недійсне.'));
    try {
      await authRequest('/api/auth/reset-password', { token: resetToken, password: pass });
      setResetToken(null);
      setAuthNotice('Пароль змінено. Тепер увійдіть до акаунта.');
      clearIdentity();
    } catch (error) { handleError(error); }
  };
  const updateProfileData = async (updates: Partial<UserProfile>) => {
    const account = userRef.current;
    if (!account) throw new Error('Увійдіть у свій акаунт.');
    const clean = stripLegacySecrets(updates as UserProfile);
    delete clean.uid;
    delete clean.email;
    delete clean.createdAt;
    delete clean.updatedAt;
    const write = writeQueue.current.catch(() => {}).then(async () => {
      if (userRef.current?.uid !== account.uid) throw new Error('Обліковий запис змінився.');
      const original = profileRef.current || { uid: account.uid, email: account.email, displayName: account.displayName };
      const updated = mergeProfileUpdate(original, clean);
      const payload = { ...clean,
        ...(clean.hookChartPreferences ? { hookChartPreferences: updated.hookChartPreferences } : {}),
      };
      const response = await apiFetch('/api/account/profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Не вдалося зберегти профіль.');
      if (userRef.current?.uid !== account.uid) throw new Error('Обліковий запис змінився.');
      const nextProfile = stripLegacySecrets(result.profile as UserProfile);
      profileRef.current = nextProfile;
      setProfile(nextProfile);
      setUser(result.user as H00kUser);
      applySitePreferences(nextProfile, account.uid);
    });
    writeQueue.current = write;
    await write;
  };
  const logout = async () => {
    if (userRef.current) {
      try {
        const response = await apiFetch('/api/auth/logout', { method: 'POST' });
        if (!response.ok) throw new Error('Не вдалося завершити сесію.');
      } catch (error) { throw error; }
    }
    clearIdentity();
  };
  const logoutAll = async () => {
    const response = await apiFetch('/api/auth/logout-all', { method: 'POST' });
    if (!response.ok) throw new Error('Не вдалося завершити сесії.');
    clearIdentity();
  };
  const listSessions = async (): Promise<AuthSessionSummary[]> => {
    const response = await apiFetch('/api/auth/sessions');
    if (!response.ok) throw new Error('Не вдалося завантажити сесії.');
    const data = await response.json();
    return Array.isArray(data.sessions) ? data.sessions : [];
  };
  const revokeSession = async (id: string) => {
    const response = await apiFetch('/api/auth/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!response.ok) throw new Error('Не вдалося завершити сесію.');
    const result = await response.json();
    if (result.revokedCurrent) clearIdentity();
  };

  return <AuthContext.Provider value={{
    user, profile, loading, signInWithGoogle, signInWithEmail, registerWithEmail,
    resendVerification, requestPasswordReset, resetPassword, resetToken,
    updateProfileData, logout, logoutAll, listSessions, revokeSession,
    authError, authErrorCode, authNotice, clearAuthError,
  }}>{children}</AuthContext.Provider>;
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
