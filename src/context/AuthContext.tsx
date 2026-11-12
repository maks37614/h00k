import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  User,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, onSnapshot, deleteField } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { UserProfile } from '../types';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrors';
import { cleanForFirestore } from '../lib/firestoreUtils';
import { verifyAccessCode, normalizeAccessCode } from '../utils/accessCodes';
import { getStoredPreferences, saveStoredPreferences } from '../utils/userPreferences';
import { DEFAULT_METASCALP_SETTINGS, saveStoredMetaScalpSettings } from '../utils/metaScalpService';
import { mergeProfileUpdate } from '../utils/hookchartData';

function cleanLegacyTelegramFields(profile: UserProfile): UserProfile {
  const clean = { ...profile } as UserProfile & Record<string, unknown>;
  delete clean.telegramBotToken;
  delete clean.telegramChatId;
  delete clean.telegramBotUsername;
  return clean;
}

function getLocalUserId(email: string): string {
  let hash = 0;
  const clean = email.trim().toLowerCase();
  for (let i = 0; i < clean.length; i++) {
    hash = (hash << 5) - hash + clean.charCodeAt(i);
    hash |= 0;
  }
  const prefix = clean.replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `usr_${prefix}_${Math.abs(hash).toString(36)}`;
}

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signInWithGoogle: (inviteCode?: string, isSignUp?: boolean) => Promise<void>;
  signInWithEmail: (email: string, pass: string) => Promise<void>;
  registerWithEmail: (email: string, pass: string, name?: string, inviteCode?: string) => Promise<void>;
  updateProfileData: (updates: Partial<UserProfile>) => Promise<void>;
  logout: () => Promise<void>;
  authError: string | null;
  authErrorCode: string | null;
  clearAuthError: () => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const profileRef = useRef(profile);
  const userRef = useRef(user);
  const profileWriteQueue = useRef<Promise<void>>(Promise.resolve());
  profileRef.current = profile;
  userRef.current = user;
  const [loading, setLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authErrorCode, setAuthErrorCode] = useState<string | null>(null);

  const clearAuthError = () => {
    setAuthError(null);
    setAuthErrorCode(null);
  };

  // Sync or create user profile in Firestore
  const syncUserProfile = async (firebaseUser: User, providedInviteCode?: string, isExplicitSignUp?: boolean) => {
    const userDocRef = doc(db, 'users', firebaseUser.uid);
    try {
      const snap = await getDoc(userDocRef);
      if (!snap.exists()) {
        if (!providedInviteCode && !isExplicitSignUp) {
          await signOut(auth);
          setUser(null);
          setProfile(null);
          const err = new Error(
            'Цей акаунт ще не зареєстрований. Будь ласка, перейдіть на вкладку «Реєстрація» та введіть спеціальний код доступу з Telegram каналу автора.'
          );
          setAuthError(err.message);
          throw err;
        }
        const storedPrefs = getStoredPreferences();
        const code = (providedInviteCode || '').trim();
        const newProfile: UserProfile = {
          uid: firebaseUser.uid,
          email: firebaseUser.email || '',
          displayName: firebaseUser.displayName || (firebaseUser.email ? firebaseUser.email.split('@')[0] : 'Користувач'),
          photoURL: firebaseUser.photoURL || '',
          soundAlertsEnabled: storedPrefs.soundAlertsEnabled,
          marketSentimentExpanded: true,
          defaultExchange: storedPrefs.defaultExchange,
          defaultMarketType: storedPrefs.defaultMarketType,
          defaultTimeframe: storedPrefs.defaultTimeframe,
          watchlist: [],
          watchlistFolders: {},
          metaScalpSettings: DEFAULT_METASCALP_SETTINGS,
          chartTradeMarkers: { showEntry: true, showTarget: true, showStop: true },
          chartLabelSettings: { entry: true, target: true, stop: true },
          terminalSettings: { columns: 2, blockHeight: 'medium', blocks: [] },
          searchSettings: { minVolumeUsd: 0, presetFilter: 'all', sortBy: 'volume', sortDirection: 'desc' },
          inviteCode: code,
          installGuideTipShown: false,
           onboardingCompleted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await setDoc(userDocRef, cleanForFirestore(newProfile));
        setProfile(newProfile);
        saveStoredMetaScalpSettings(newProfile.metaScalpSettings!, firebaseUser.uid);
      } else {
        const rawProfile = snap.data() as UserProfile;
        const loadedProfile = cleanLegacyTelegramFields(rawProfile);
        setProfile(loadedProfile);
        if (rawProfile.telegramBotToken || rawProfile.telegramChatId || rawProfile.telegramBotUsername) {
          void updateDoc(userDocRef, {
            telegramBotToken: deleteField(), telegramChatId: deleteField(), telegramBotUsername: deleteField(),
          }).catch(() => console.warn('[Profile] Could not clear legacy personal Telegram fields'));
        }
        // Sync Firestore profile defaults into website-wide storage
        if (loadedProfile) {
          saveStoredPreferences({
            ...(loadedProfile.defaultExchange ? { defaultExchange: loadedProfile.defaultExchange } : {}),
            ...(loadedProfile.defaultMarketType ? { defaultMarketType: loadedProfile.defaultMarketType } : {}),
            ...(loadedProfile.defaultTimeframe ? { defaultTimeframe: loadedProfile.defaultTimeframe } : {}),
            ...(loadedProfile.soundAlertsEnabled !== undefined ? { soundAlertsEnabled: loadedProfile.soundAlertsEnabled } : {}),
          });
          if (loadedProfile.metaScalpSettings) {
            saveStoredMetaScalpSettings(loadedProfile.metaScalpSettings, firebaseUser.uid);
          }
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `users/${firebaseUser.uid}`);
    }
  };

  useEffect(() => {
    try {
      localStorage.removeItem('signalhook_tg_token');
      localStorage.removeItem('signalhook_tg_chat_id');
    } catch {}
  }, []);

  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;

    // Check existing local session first
    try {
      const sessionRaw = localStorage.getItem('signalhook_local_session');
      if (import.meta.env.DEV && sessionRaw) {
        const session = JSON.parse(sessionRaw);
        if (session && session.user) {
          setUser(session.user);
          if (session.profile) {
            const cleanProfile = cleanLegacyTelegramFields(session.profile as UserProfile);
            setProfile(cleanProfile);
            session.profile = cleanProfile;
            localStorage.setItem('signalhook_local_session', JSON.stringify(session));
          }
          setLoading(false);
        }
      }
    } catch {}

    const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        // Firebase user takes precedence
        setUser(currentUser);
        try {
          localStorage.removeItem('signalhook_local_session');
        } catch {}

        await syncUserProfile(currentUser);

        // Realtime listener for profile changes
        const userDocRef = doc(db, 'users', currentUser.uid);
        unsubscribeProfile = onSnapshot(
          userDocRef,
          (docSnap) => {
            if (docSnap.exists()) {
              const updatedData = cleanLegacyTelegramFields(docSnap.data() as UserProfile);
              setProfile(updatedData);
              if (updatedData) {
                saveStoredPreferences({
                  ...(updatedData.defaultExchange ? { defaultExchange: updatedData.defaultExchange } : {}),
                  ...(updatedData.defaultMarketType ? { defaultMarketType: updatedData.defaultMarketType } : {}),
                  ...(updatedData.defaultTimeframe ? { defaultTimeframe: updatedData.defaultTimeframe } : {}),
                  ...(updatedData.soundAlertsEnabled !== undefined ? { soundAlertsEnabled: updatedData.soundAlertsEnabled } : {}),
                });
              }
            }
          },
          (error) => {
            handleFirestoreError(error, OperationType.GET, `users/${currentUser.uid}`);
          }
        );
      } else {
        // If not a Firebase user, check if we have an active local session
        const sessionRaw = localStorage.getItem('signalhook_local_session');
        if (import.meta.env.DEV && sessionRaw) {
          try {
            const session = JSON.parse(sessionRaw);
            if (session?.user) {
              setUser(session.user);
              setProfile(session.profile || null);
            } else {
              setUser(null);
              setProfile(null);
            }
          } catch {
            setUser(null);
            setProfile(null);
          }
        } else {
          setUser(null);
          setProfile(null);
        }

        if (unsubscribeProfile) {
          unsubscribeProfile();
          unsubscribeProfile = null;
        }
      }
      setLoading(false);
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfile) unsubscribeProfile();
    };
  }, []);

  const signInWithGoogle = async (inviteCode?: string, isSignUp?: boolean) => {
    setAuthError(null);
    setAuthErrorCode(null);

    // If explicit registration requested, verify access code first
    let verifiedCode = (inviteCode || '').trim();
    if (isSignUp) {
      if (!verifiedCode) {
        const err = new Error('Для реєстрації через Google потрібен спеціальний код доступу з Telegram каналу автора.');
        setAuthError(err.message);
        throw err;
      }
      const verification = await verifyAccessCode(verifiedCode);
      if (!verification.valid) {
        const err = new Error(verification.message || 'Недійсний спеціальний код доступу. Отримайте дійсний код у Telegram каналі автора.');
        setAuthError(err.message);
        throw err;
      }
      verifiedCode = verification.normalizedCode;
    }

    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const result = await signInWithPopup(auth, provider);
      if (result.user) {
        await syncUserProfile(result.user, verifiedCode || undefined, isSignUp);
      }
    } catch (err: any) {
      console.error('Google sign in error:', err);
      if (err.code === 'auth/popup-closed-by-user') {
        setAuthError('Вхід скасовано (вікно було закрите)');
      } else if (err.code === 'auth/cancelled-popup-request') {
        // silently handled
      } else if (err.code === 'auth/popup-blocked') {
        setAuthError('Браузер заблокував спливаюче вікно. Дозвольте pop-up вікна для цього сайту або відкрийте додаток у новій вкладці.');
      } else {
        setAuthError(err.message || 'Помилка авторизації через Google');
      }
      setAuthErrorCode(err.code || null);
      throw err;
    }
  };

  const signInWithEmail = async (email: string, pass: string) => {
    setAuthError(null);
    setAuthErrorCode(null);
    const cleanEmail = email.trim().toLowerCase();

    try {
      const result = await signInWithEmailAndPassword(auth, cleanEmail, pass);
      if (result.user) {
        try {
          localStorage.removeItem('signalhook_local_session');
        } catch {}
        await syncUserProfile(result.user);
      }
      return;
    } catch (err: any) {
      const isNotAllowed =
        err?.code === 'auth/operation-not-allowed' ||
        err?.code === 'auth/admin-restricted-operation' ||
        (typeof err?.message === 'string' && (
          err.message.includes('operation-not-allowed') ||
          err.message.includes('auth/operation-not-allowed') ||
          err.message.includes('CONFIGURATION_NOT_FOUND')
        ));

      if (import.meta.env.DEV && isNotAllowed) {
        try {
          const accountsRaw = localStorage.getItem('signalhook_local_accounts');
          const accounts = accountsRaw ? JSON.parse(accountsRaw) : {};
          const account = accounts[cleanEmail];

          if (account) {
            if (account.passHash && account.passHash !== btoa(pass)) {
              setAuthError('Невірний пароль для цього email');
              throw new Error('Невірний пароль');
            }
            const uid = account.uid || getLocalUserId(cleanEmail);
            const localUser: any = {
              uid,
              email: cleanEmail,
              displayName: account.displayName || cleanEmail.split('@')[0],
              photoURL: '',
              isLocalUser: true,
            };
            const savedProfileRaw = localStorage.getItem(`signalhook_profile_${uid}`);
            const localProfile: UserProfile = savedProfileRaw
              ? cleanLegacyTelegramFields(JSON.parse(savedProfileRaw) as UserProfile)
              : {
                  uid,
                  email: cleanEmail,
                  displayName: account.displayName || cleanEmail.split('@')[0],
                  photoURL: '',
                  soundAlertsEnabled: true,
                  defaultExchange: 'all',
                  defaultMarketType: 'all',
                  defaultTimeframe: '1h',
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                };

            localStorage.setItem(`signalhook_profile_${uid}`, JSON.stringify(localProfile));
            localStorage.setItem('signalhook_local_session', JSON.stringify({ user: localUser, profile: localProfile }));
            setUser(localUser);
            setProfile(localProfile);
            return;
          } else {
            // Auto-register and sign in locally
            const uid = getLocalUserId(cleanEmail);
            const displayName = cleanEmail.split('@')[0];
            accounts[cleanEmail] = {
              uid,
              email: cleanEmail,
              displayName,
              passHash: btoa(pass),
              createdAt: new Date().toISOString(),
            };
            localStorage.setItem('signalhook_local_accounts', JSON.stringify(accounts));

            const localUser: any = {
              uid,
              email: cleanEmail,
              displayName,
              photoURL: '',
              isLocalUser: true,
            };
            const localProfile: UserProfile = {
              uid,
              email: cleanEmail,
              displayName,
              photoURL: '',
              soundAlertsEnabled: true,
              defaultExchange: 'all',
              defaultMarketType: 'all',
              defaultTimeframe: '1h',
              installGuideTipShown: false,
           onboardingCompleted: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };

            localStorage.setItem('signalhook_local_session', JSON.stringify({ user: localUser, profile: localProfile }));
            localStorage.setItem(`signalhook_profile_${uid}`, JSON.stringify(localProfile));
            setUser(localUser);
            setProfile(localProfile);
            return;
          }
        } catch (localErr: any) {
          if (localErr.message === 'Невірний пароль') throw localErr;
        }
      }

      setAuthErrorCode(err.code || null);
      if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
        setAuthError('Невірний email або пароль');
      } else if (err.code === 'auth/invalid-email') {
        setAuthError('Некоректний формат email адреси');
      } else if (err.code === 'auth/too-many-requests') {
        setAuthError('Забагато невдалих спроб. Спробуйте пізніше.');
      } else {
        setAuthError(err.message || 'Помилка входу');
      }
      throw err;
    }
  };

  const registerWithEmail = async (email: string, pass: string, name?: string, inviteCode?: string) => {
    setAuthError(null);
    setAuthErrorCode(null);

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
      const err = new Error('Введіть адресу електронної пошти');
      setAuthError(err.message);
      throw err;
    }

    if (!pass || pass.length < 6) {
      const err = new Error('Пароль повинен містити не менше 6 символів');
      setAuthError(err.message);
      throw err;
    }

    // Access codes are verified by the server and never default to a public code.
    const codeToVerify = (inviteCode || '').trim();
    const verification = await verifyAccessCode(codeToVerify);
    if (!verification.valid) {
      const err = new Error(verification.message || 'Недійсний спеціальний код доступу.');
      setAuthError(err.message);
      throw err;
    }
    const validInviteCode = verification.normalizedCode;

    try {
      const result = await createUserWithEmailAndPassword(auth, cleanEmail, pass);
      if (name && name.trim() && result.user) {
        await updateProfile(result.user, { displayName: name.trim() });
      }
      if (result.user) {
        try {
          localStorage.removeItem('signalhook_local_session');
        } catch {}
        const userDocRef = doc(db, 'users', result.user.uid);
        const newProfile: UserProfile = {
          uid: result.user.uid,
          email: result.user.email || '',
          displayName: name?.trim() || cleanEmail.split('@')[0],
          photoURL: '',
          soundAlertsEnabled: true,
          defaultExchange: 'all',
          defaultMarketType: 'all',
          defaultTimeframe: '1h',
          watchlist: [],
          metaScalpSettings: { enabled: true, port: 17845, binding: '001', autoSwitchOnClick: true },
          inviteCode: validInviteCode,
          installGuideTipShown: false,
           onboardingCompleted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await setDoc(userDocRef, cleanForFirestore(newProfile));
        setProfile(newProfile);
      }
    } catch (err: any) {
      const isNotAllowed =
        err?.code === 'auth/operation-not-allowed' ||
        err?.code === 'auth/admin-restricted-operation' ||
        (typeof err?.message === 'string' && (
          err.message.includes('operation-not-allowed') ||
          err.message.includes('auth/operation-not-allowed') ||
          err.message.includes('CONFIGURATION_NOT_FOUND')
        ));

      if (import.meta.env.DEV && isNotAllowed) {
        const uid = getLocalUserId(cleanEmail);
        const displayName = name?.trim() || cleanEmail.split('@')[0];

        try {
          const accountsRaw = localStorage.getItem('signalhook_local_accounts');
          const accounts = accountsRaw ? JSON.parse(accountsRaw) : {};
          accounts[cleanEmail] = {
            uid,
            email: cleanEmail,
            displayName,
            passHash: btoa(pass),
            inviteCode: validInviteCode,
            createdAt: new Date().toISOString(),
          };
          localStorage.setItem('signalhook_local_accounts', JSON.stringify(accounts));
        } catch {}

        const localUser: any = {
          uid,
          email: cleanEmail,
          displayName,
          photoURL: '',
          isLocalUser: true,
        };

        const localProfile: UserProfile = {
          uid,
          email: cleanEmail,
          displayName,
          photoURL: '',
          soundAlertsEnabled: true,
          defaultExchange: 'all',
          defaultMarketType: 'all',
          defaultTimeframe: '1h',
          watchlist: [],
          metaScalpSettings: { enabled: true, port: 17845, binding: '001', autoSwitchOnClick: true },
          inviteCode: validInviteCode,
          installGuideTipShown: false,
           onboardingCompleted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        try {
          localStorage.setItem('signalhook_local_session', JSON.stringify({ user: localUser, profile: localProfile }));
          localStorage.setItem(`signalhook_profile_${uid}`, JSON.stringify(localProfile));
        } catch {}

        setUser(localUser);
        setProfile(localProfile);
        return;
      }

      console.error('Email registration error:', err);
      setAuthErrorCode(err.code || null);
      if (err.code === 'auth/email-already-in-use') {
        setAuthError('Користувач з таким email вже зареєстрований. Увійдіть у свій профіль.');
      } else if (err.code === 'auth/weak-password') {
        setAuthError('Пароль занадто простий (мінімум 6 символів)');
      } else if (err.code === 'auth/invalid-email') {
        setAuthError('Некоректний формат email адреси');
      } else {
        setAuthError(err.message || 'Помилка реєстрації');
      }
      throw err;
    }
  };

  const updateProfileData = async (updates: Partial<UserProfile>) => {
    updates = cleanLegacyTelegramFields(updates as UserProfile);
    const account = user;
    if (!account) return;

    const write = profileWriteQueue.current.catch(() => {}).then(async () => {
      if (userRef.current?.uid !== account.uid) {
        throw new Error('Обліковий запис змінився. Відкрийте налаштування повторно.');
      }

      const current = profileRef.current?.uid === account.uid ? profileRef.current : {
        uid: account.uid,
        email: account.email || '',
        displayName: account.displayName || 'Користувач',
      };
      const updatedAt = new Date().toISOString();
      const payload = mergeProfileUpdate(current, { ...updates, updatedAt });
      const isLocalUser = Boolean((account as any).isLocalUser);

      if (
        updates.defaultExchange !== undefined ||
        updates.defaultMarketType !== undefined ||
        updates.defaultTimeframe !== undefined ||
        updates.soundAlertsEnabled !== undefined
      ) {
        saveStoredPreferences({
          ...(updates.defaultExchange ? { defaultExchange: updates.defaultExchange } : {}),
          ...(updates.defaultMarketType ? { defaultMarketType: updates.defaultMarketType } : {}),
          ...(updates.defaultTimeframe ? { defaultTimeframe: updates.defaultTimeframe } : {}),
          ...(updates.soundAlertsEnabled !== undefined ? { soundAlertsEnabled: updates.soundAlertsEnabled } : {}),
        });
      }

      if (isLocalUser) {
        try {
          localStorage.setItem(`signalhook_profile_${account.uid}`, JSON.stringify(payload));
          localStorage.setItem('signalhook_local_session', JSON.stringify({ user: account, profile: payload }));
        } catch {}
        profileRef.current = payload;
        setProfile(payload);

        return;
      }

      try {
        const userDocRef = doc(db, 'users', account.uid);
        await updateDoc(
          userDocRef,
          cleanForFirestore({
            ...updates,
            ...(updates.hookChartPreferences ? { hookChartPreferences: payload.hookChartPreferences } : {}),
            updatedAt,
          })
        );
        if (userRef.current?.uid === account.uid) {
          const latest = profileRef.current?.uid === account.uid ? profileRef.current : payload;
          const next = mergeProfileUpdate(latest, { ...updates, updatedAt });
          profileRef.current = next;
          setProfile(next);
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `users/${account.uid}`);
        throw err;
      }
    });

    profileWriteQueue.current = write;
    await write;
  };

  const logout = async () => {
    try {
      if (!(user as any)?.isLocalUser) {
        await signOut(auth);
      }
    } catch (err) {
      // ignore
    } finally {
      try {
        localStorage.removeItem('signalhook_local_session');
      } catch {}
      setProfile(null);
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        signInWithGoogle,
        signInWithEmail,
        registerWithEmail,
        updateProfileData,
        logout,
        authError,
        authErrorCode,
        clearAuthError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
