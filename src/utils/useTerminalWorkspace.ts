import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useAuth } from '../context/AuthContext';
import type { TerminalChartBlock, TerminalSavedPreset, TerminalWorkspaceConfig, TerminalWorkspaceSettings } from '../types';
import { getStoredPreferences } from './userPreferences';
import { normalizeVisualProfile } from '../components/hookchart/visualProfiles';
import { normalizeTerminalBlocks, normalizeTerminalPresets, terminalStorageKey, TERMINAL_PRESETS_STORAGE_KEY } from './terminalPresets';

const BLOCKS_KEY = 'crypto_screener_terminal_blocks';
const CONFIG_KEY = 'crypto_screener_terminal_config';
const CONFLICT_KEY = 'crypto_screener_terminal_conflict_backup';
type WorkspaceSnapshot = { blocks: TerminalChartBlock[]; config: TerminalWorkspaceConfig; presets: TerminalSavedPreset[] };
function readConflictBackup(uid?: string): WorkspaceSnapshot | null {
  if (!uid) return null;
  const raw = readCache(CONFLICT_KEY, uid);
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<WorkspaceSnapshot>;
  if (!Array.isArray(value.blocks) || !value.config || typeof value.config !== 'object'
      || !Array.isArray(value.presets)) return null;
  return { blocks: normalizeTerminalBlocks(value.blocks), config: value.config,
    presets: normalizeTerminalPresets(value.presets) };
}
function saveConflictBackup(uid: string, value: WorkspaceSnapshot): boolean {
  try {
    localStorage.setItem(terminalStorageKey(CONFLICT_KEY, uid),
      JSON.stringify({ ...value, savedAt: new Date().toISOString() }));
    return true;
  } catch { return false; }
}
const DEFAULT_CONFIG: TerminalWorkspaceConfig = {
  layoutPreset: 'custom', columns: 2, autoFitScreen: true, blocks: [], showFormations: true, blockHeight: 'medium',
};
function readCache(key: string, uid?: string): unknown {
  try { return JSON.parse(localStorage.getItem(terminalStorageKey(key, uid)) || 'null'); } catch { return null; }
}
export function loadTerminalWorkspace(uid?: string, settings?: TerminalWorkspaceSettings) {
  const storedBlocks = readCache(BLOCKS_KEY, uid);
  const storedConfig = readCache(CONFIG_KEY, uid);
  const recovery = readConflictBackup(uid);
  const prefs = getStoredPreferences();
  const defaultBlock: TerminalChartBlock = { id: 'block-btc-default', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
    exchange: prefs.defaultExchange === 'all' ? 'binance' : prefs.defaultExchange,
    marketType: prefs.defaultMarketType === 'all' ? 'futures' : prefs.defaultMarketType,
    timeframe: prefs.defaultTimeframe, colSpan: 1 };
  const sourceConfig = recovery ? recovery.config
    : settings ? { ...settings.config, columns: settings.columns, blockHeight: settings.blockHeight }
    : storedConfig && typeof storedConfig === 'object' ? storedConfig : {};
  const config = { ...DEFAULT_CONFIG, ...sourceConfig } as TerminalWorkspaceConfig;
  if (![1, 2, 3, 4, 5, 6].includes(config.columns)) config.columns = 2;
  if ((config.blockHeight as string) === 'tall') config.blockHeight = 'large';
  if (!['compact', 'medium', 'large'].includes(config.blockHeight)) config.blockHeight = 'medium';
  if (config.initialChartView != null) {
    config.initialChartView = normalizeVisualProfile(config.initialChartView, 'terminalMedium');
  }
  return { blocks: recovery?.blocks ?? (Array.isArray(settings?.blocks) ? normalizeTerminalBlocks(settings.blocks)
    : Array.isArray(storedBlocks) ? normalizeTerminalBlocks(storedBlocks) : [defaultBlock]), config,
    presets: normalizeTerminalPresets(recovery?.presets ?? settings?.customPresets ?? readCache(TERMINAL_PRESETS_STORAGE_KEY, uid)) };
}

/** TerminalPage is keyed by account, so pending writes cannot cross an account change. */
export function useTerminalWorkspace() {
  const { user, profile, updateTerminalWorkspace } = useAuth();
  const uid = user?.uid;
  const [workspace, setWorkspace] = useState(() => loadTerminalWorkspace(uid, profile?.uid === uid ? profile?.terminalSettings : undefined));
  const [syncError, setSyncError] = useState(() => Boolean(readConflictBackup(uid)));
  const [syncConflict, setSyncConflict] = useState(() => Boolean(readConflictBackup(uid)));
  const [backupFailed, setBackupFailed] = useState(false);
  const syncConflictRef = useRef(syncConflict);
  const serverVersion = useRef<string | null>(profile?.terminalSettings?.version ?? null);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const hydrated = useRef(Boolean(!uid || profile?.uid === uid));
  const authRef = useRef({ uid, profile, updateTerminalWorkspace });
  authRef.current = { uid, profile, updateTerminalWorkspace };
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const saveQueue = useRef(Promise.resolve());
  const mounted = useRef(true);

  const persistToProfile = useCallback((value: typeof workspace, currentRevision: number) => {
    saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
      const auth = authRef.current;
      if (!uid || auth.uid !== uid || auth.profile?.uid !== uid
        || currentRevision < revision.current || syncConflictRef.current) return;
      const { blocks: _blocks, ...config } = value.config;
      const nextVersion = await auth.updateTerminalWorkspace({
        columns: config.columns, blockHeight: config.blockHeight, config,
        blocks: value.blocks, customPresets: value.presets,
      }, serverVersion.current);
      serverVersion.current = nextVersion;
      savedRevision.current = currentRevision;
      if (mounted.current) { setSyncError(false); setSyncConflict(false); }
    }).catch((error: Error & { code?: string }) => {
      if (error.code === 'TERMINAL_WORKSPACE_CONFLICT') {
        syncConflictRef.current = true;
        const saved = uid ? saveConflictBackup(uid, workspaceRef.current) : false;
        if (mounted.current && !saved) setBackupFailed(true);
      }
      if (!mounted.current) return;
      setSyncError(true);
      if (error.code === 'TERMINAL_WORKSPACE_CONFLICT') setSyncConflict(true);
    });
  }, [uid]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!syncConflictRef.current && revision.current !== savedRevision.current)
        persistToProfile(workspaceRef.current, revision.current);
    };
  }, [persistToProfile]);

  useEffect(() => {
    if (hydrated.current || !uid || profile?.uid !== uid) return;
    hydrated.current = true;
    serverVersion.current = profile.terminalSettings?.version ?? null;
    // A late profile response must not overwrite a user's new selection.
    if (revision.current === 0 && !syncConflictRef.current)
      setWorkspace(loadTerminalWorkspace(uid, profile.terminalSettings));
  }, [uid, profile]);

  useEffect(() => {
    if (uid && profile?.uid === uid && !syncConflict) {
      serverVersion.current = profile.terminalSettings?.version ?? null;
    }
  }, [uid, profile?.uid, profile?.terminalSettings?.version, syncConflict]);

  const setField = useCallback(<K extends keyof typeof workspace>(field: K, update: SetStateAction<(typeof workspace)[K]>) => {
    setWorkspace(current => {
      const value = typeof update === 'function' ? (update as (previous: (typeof workspace)[K]) => (typeof workspace)[K])(current[field]) : update;
      if (value === current[field]) return current;
      revision.current += 1;
      return { ...current, [field]: value };
    });
  }, []);
  const setBlocks: Dispatch<SetStateAction<TerminalChartBlock[]>> = useCallback(update => setField('blocks', update), [setField]);
  const setConfig: Dispatch<SetStateAction<TerminalWorkspaceConfig>> = useCallback(update => setField('config', update), [setField]);
  const setCustomPresets: Dispatch<SetStateAction<TerminalSavedPreset[]>> = useCallback(update => setField('presets', update), [setField]);

  useEffect(() => {
    if (revision.current === savedRevision.current) return;
    try {
      localStorage.setItem(terminalStorageKey(BLOCKS_KEY, uid), JSON.stringify(workspace.blocks));
      localStorage.setItem(terminalStorageKey(CONFIG_KEY, uid), JSON.stringify(workspace.config));
      localStorage.setItem(terminalStorageKey(TERMINAL_PRESETS_STORAGE_KEY, uid), JSON.stringify(workspace.presets));
    } catch { setSyncError(true); }
    if (uid && syncConflictRef.current) {
      const stored = saveConflictBackup(uid, workspace);
      setBackupFailed(!stored);
    }
    if (!uid || !hydrated.current || syncConflict) return;
    const currentRevision = revision.current;
    const timer = setTimeout(() => persistToProfile(workspace, currentRevision), 1200);
    return () => clearTimeout(timer);
  }, [workspace, uid, profile?.uid, persistToProfile, syncConflict]);

  const retrySync = useCallback(() => {
    if (syncConflict) return; // A conflicting version needs explicit reconciliation.
    revision.current += 1;
    setWorkspace(current => ({ ...current }));
  }, [syncConflict]);

  const restoreCloudWorkspace = useCallback(() => {
    if (!uid || !syncConflictRef.current) return;
    if (!window.confirm('Локальні зміни не буде завантажено в хмару. Спочатку експортуйте JSON-копію. Повернути хмарну версію?')) return;
    try {
      localStorage.removeItem(terminalStorageKey(CONFLICT_KEY, uid));
      window.location.reload(); // Loads the latest server profile after conflict recovery.
    } catch { setSyncError(true); }
  }, [uid]);

  const downloadLocalBackup = useCallback(() => {
    const snapshot = workspaceRef.current;
    const json = JSON.stringify({ exportedAt: new Date().toISOString(), ...snapshot }, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'h00k-terminal-local-backup.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  return { blocks: workspace.blocks, config: workspace.config, customPresets: workspace.presets,
    setBlocks, setConfig, setCustomPresets, syncError, syncConflict, retrySync,
    downloadLocalBackup, restoreCloudWorkspace, backupFailed };
}
