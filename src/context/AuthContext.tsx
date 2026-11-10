import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { UserProfile } from "../types";
import { apiJson, setApiAccount } from "../utils/apiFetch";
import { saveStoredPreferences } from "../utils/userPreferences";
import { saveStoredMetaScalpSettings } from "../utils/metaScalpService";
export interface H00kUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  emailVerified?: boolean;
}
interface AuthContextType {
  user: H00kUser | null;
  profile: UserProfile | null;
  loading: boolean;
  signInWithEmail: (
    email: string,
    password: string,
    code?: string,
  ) => Promise<void>;
  registerWithEmail: (
    email: string,
    password: string,
    name?: string,
    inviteCode?: string,
  ) => Promise<void>;
  updateProfileData: (updates: Partial<UserProfile>) => Promise<void>;
  logout: () => Promise<void>;
  authError: string | null;
  authErrorCode: string | null;
  clearAuthError: () => void;
}
export const AuthContext = createContext<AuthContextType | undefined>(
  undefined,
);
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<H00kUser | null>(null),
    [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true),
    [authError, setError] = useState<string | null>(null);
  const owner = useRef<string | null>(null),
    queue = useRef<Promise<void>>(Promise.resolve());
  function apply(data: any) {
    const id = data.user?.uid ?? null;
    owner.current = id;
    setApiAccount(id);
    setUser(data.user ?? null);
    setProfile(data.profile ?? null);
    if (data.profile) {
      const p = data.profile;
      saveStoredPreferences({
        ...(p.defaultExchange ? { defaultExchange: p.defaultExchange } : {}),
        ...(p.defaultMarketType
          ? { defaultMarketType: p.defaultMarketType }
          : {}),
        ...(p.defaultTimeframe ? { defaultTimeframe: p.defaultTimeframe } : {}),
        ...(p.soundAlertsEnabled !== undefined
          ? { soundAlertsEnabled: p.soundAlertsEnabled }
          : {}),
      });
      if (p.metaScalpSettings)
        saveStoredMetaScalpSettings(p.metaScalpSettings, id);
    }
  }
  useEffect(() => {
    let active = true;
    void apiJson("/api/account/me")
      .then((data) => {
        if (active) apply(data);
      })
      .catch(() => {
        if (active) apply({});
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function authenticate(path: string, body: unknown) {
    setError(null);
    try {
      apply(
        await apiJson("/api/account/" + path, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Не вдалося увійти";
      setError(message);
      throw error;
    }
  }
  const updateProfileData = async (updates: Partial<UserProfile>) => {
    const id = owner.current;
    if (!id) throw new Error("Увійдіть у свій акаунт");
    const write = queue.current
      .catch(() => {})
      .then(async () => {
        if (owner.current !== id) throw new Error("Акаунт змінився");
        const data = await apiJson("/api/account/profile", {
          method: "PATCH",
          body: JSON.stringify(updates),
        });
        if (owner.current === id) setProfile(data.profile);
      });
    queue.current = write;
    await write;
  };
  const logout = async () => {
    await apiJson("/api/account/logout", { method: "POST" });
    apply({});
  };
  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        authError,
        authErrorCode: null,
        clearAuthError: () => setError(null),
        signInWithEmail: (email, password, code) =>
          authenticate("login", { email, password, code }),
        registerWithEmail: (email, password, displayName) =>
          authenticate("register", { email, password, displayName }),
        updateProfileData,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth потребує AuthProvider");
  return value;
}
