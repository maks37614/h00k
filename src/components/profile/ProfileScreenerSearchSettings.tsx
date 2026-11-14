import React, { useEffect, useMemo, useState } from 'react';
import { BookmarkPlus, CheckCircle2, Search, Trash2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import type { ScreenerSearchConfig, SearchUserSettings } from '../../types';
import { getStoredPreferences } from '../../utils/userPreferences';
import { SCREENER_VOLUME_CAPS } from '../../utils/screenerVolume';
import {
  MAX_SCREENER_SEARCH_PRESETS, SCREENER_SEARCH_SORT_OPTIONS,
  normalizeScreenerSearchConfig, normalizeScreenerSearchSettings,
} from '../../utils/screenerSearchSettings';

const control = 'w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none';
const label = 'block space-y-1 text-xs font-medium text-slate-300';

const filters = [
  { value: 'all', label: 'Усі монети' },
  { value: 'active', label: 'Активні' },
  { value: 'top_gainers', label: 'Топ зростання' },
  { value: 'top_losers', label: 'Топ падіння' },
  { value: 'near_highs', label: 'Біля максимумів' },
  { value: 'near_lows', label: 'Біля мінімумів' },
] as const;

function preferredFallback(profile: { defaultExchange?: ScreenerSearchConfig['exchange']; defaultMarketType?: ScreenerSearchConfig['marketType'] } | null) {
  const stored = getStoredPreferences();
  return {
    exchange: profile?.defaultExchange ?? stored.defaultExchange,
    marketType: profile?.defaultMarketType ?? stored.defaultMarketType,
  };
}

/** Profile-only editor. No quote polling, chart mounting or exchange requests. */
export function ProfileScreenerSearchSettings() {
  const { user, profile, updateProfileData } = useAuth();
  const fallback = preferredFallback(profile);
  const stored = useMemo(() => normalizeScreenerSearchSettings(profile?.searchSettings, fallback),
    [profile?.searchSettings, fallback.exchange, fallback.marketType]);
  const [draft, setDraft] = useState<ScreenerSearchConfig>(() =>
    normalizeScreenerSearchConfig(stored.defaultConfig, fallback));
  const [presetName, setPresetName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user?.uid || profile?.uid !== user.uid) return;
    setDraft(normalizeScreenerSearchConfig(stored.defaultConfig, fallback));
    setPresetName('');
    setEditingId(null);
    setMessage('');
    setError('');
    // Switching accounts must never carry edited search presets across users.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, profile?.uid]);

  const setField = <K extends keyof ScreenerSearchConfig>(key: K, value: ScreenerSearchConfig[K]) => {
    setDraft(previous => normalizeScreenerSearchConfig({ ...previous, [key]: value }, fallback));
    setMessage('');
  };

  const write = async (next: SearchUserSettings, successMessage: string): Promise<boolean> => {
    if (busy || !user?.uid || profile?.uid !== user.uid) return false;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await updateProfileData({ searchSettings: normalizeScreenerSearchSettings(next, fallback) });
      setMessage(successMessage);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не вдалося зберегти налаштування пошуку');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveDefault = () => void write({
    ...stored, defaultConfig: normalizeScreenerSearchConfig(draft, fallback), defaultPresetId: null,
  }, 'Налаштування за замовчуванням збережено для Скрінера.');

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) { setError('Введіть назву пресета.'); return; }
    const presets = stored.presets || [];
    const isEditingExisting = !!editingId && presets.some(item => item.id === editingId);
    if (!isEditingExisting && presets.length >= MAX_SCREENER_SEARCH_PRESETS) {
      setError('Досягнуто ліміт 12 пресетів. Видаліть непотрібний.'); return;
    }
    if (presets.some(item => item.name.toLowerCase() === name.toLowerCase() && item.id !== editingId)) {
      setError('Пресет із такою назвою вже існує.'); return;
    }
    const id = isEditingExisting ? editingId!
      : (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID() : `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const item = { id, name: name.slice(0, 40), config: normalizeScreenerSearchConfig(draft, fallback) };
    const next = isEditingExisting ? presets.map(p => p.id === editingId ? item : p) : [...presets, item];
    void write({ ...stored, presets: next }, isEditingExisting ? 'Пресет оновлено.' : 'Пресет створено.')
      .then(saved => { if (saved) setEditingId(id); });
  };

  const choosePreset = (id: string) => {
    const preset = stored.presets?.find(item => item.id === id);
    if (!preset) return;
    setEditingId(id);
    setPresetName(preset.name);
    setDraft(normalizeScreenerSearchConfig(preset.config, fallback));
    setMessage('');
    setError('');
  };

  const defaultPreset = (id: string) => void write({
    ...stored, defaultPresetId: id,
  }, 'Обраний пресет застосовуватиметься при відкритті Скрінера.');

  const removePreset = (id: string) => {
    if (editingId === id) {
      setEditingId(null);
      setPresetName('');
      setDraft(normalizeScreenerSearchConfig(stored.defaultConfig, fallback));
    }
    void write({
      ...stored,
      presets: (stored.presets || []).filter(item => item.id !== id),
      defaultPresetId: stored.defaultPresetId === id ? null : stored.defaultPresetId,
    }, 'Пресет видалено.');
  };

  if (!user?.uid || profile?.uid !== user.uid) return <p className="text-sm text-slate-400">Завантаження налаштувань пошуку…</p>;

  return <div className="space-y-5">
    <div className="rounded-xl border border-cyan-500/25 bg-slate-950/70 p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold text-cyan-200"><Search size={16}/> Пошук монет у Скрінері</h3>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
        Налаштування діють лише на сторінці «Скрінер». Пошук, фільтри й порядок монет використовують уже завантажені ринкові дані;
        HookChart, Формації та Раннє виявлення не змінюються.
      </p>
    </div>

    <section className="space-y-4 rounded-xl border border-slate-700/80 bg-slate-950/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-white">{editingId ? 'Редагування пресета' : 'Редактор фільтрів і сортування'}</h4>
        <button type="button" disabled={busy} onClick={() => {
          setEditingId(null); setPresetName('');
          setDraft(normalizeScreenerSearchConfig(stored.defaultConfig, fallback)); setMessage(''); setError('');
        }} className="text-xs text-cyan-300 hover:text-white disabled:opacity-50">
          Налаштувати стандартні параметри
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={label}>Пошук за монетою
          <input className={control} value={draft.searchQuery} maxLength={80}
            placeholder="Наприклад, BTC або ETH"
            onChange={event => setField('searchQuery', event.target.value)} />
        </label>
        <label className={label}>Готовий фільтр Скрінера
          <select className={control} value={draft.presetFilter} onChange={event => setField('presetFilter', event.target.value as ScreenerSearchConfig['presetFilter'])}>
            {filters.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className={label}>Біржа
          <select className={control} value={draft.exchange} onChange={event => setField('exchange', event.target.value as ScreenerSearchConfig['exchange'])}>
            <option value="all">Усі біржі</option><option value="binance">Binance</option><option value="bybit">Bybit</option>
          </select>
        </label>
        <label className={label}>Ринок
          <select className={control} value={draft.marketType} onChange={event => setField('marketType', event.target.value as ScreenerSearchConfig['marketType'])}>
            <option value="all">Усі ринки</option><option value="futures">Ф’ючерси</option><option value="spot">Спот</option>
          </select>
        </label>
        <label className={label}>Максимальний обсяг 24г
          <select className={control} value={draft.maxVolumeUsd} onChange={event => setField('maxVolumeUsd', Number(event.target.value))}>
            <option value={0}>Без обмежень</option>
            {SCREENER_VOLUME_CAPS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <div className="hidden sm:block" aria-hidden="true" />
        <label className={label}>Основний показник сортування
          <select className={control} value={draft.sortBy} onChange={event => setField('sortBy', event.target.value as ScreenerSearchConfig['sortBy'])}>
            {SCREENER_SEARCH_SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className={label}>Порядок основного показника
          <select className={control} value={draft.sortOrder} onChange={event => setField('sortOrder', event.target.value as ScreenerSearchConfig['sortOrder'])}>
            <option value="desc">За спаданням ↓</option><option value="asc">За зростанням ↑</option>
          </select>
        </label>
        <label className={label}>Другий пріоритет (за однакових значень)
          <select className={control} value={draft.secondarySortBy} onChange={event => setField('secondarySortBy', event.target.value as ScreenerSearchConfig['secondarySortBy'])}>
            <option value="none">Без другого показника</option>
            {SCREENER_SEARCH_SORT_OPTIONS.filter(option => option.value !== draft.sortBy).map(option =>
              <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className={label}>Порядок другого показника
          <select className={control} disabled={draft.secondarySortBy === 'none'} value={draft.secondarySortOrder}
            onChange={event => setField('secondarySortOrder', event.target.value as ScreenerSearchConfig['secondarySortOrder'])}>
            <option value="desc">За спаданням ↓</option><option value="asc">За зростанням ↑</option>
          </select>
        </label>
      </div>

      <p className="text-xs leading-relaxed text-slate-400">Другий показник визначає порядок лише тоді, коли значення першого однакові. Сортування не створює нових запитів до бірж.</p>
      <button type="button" disabled={busy} onClick={saveDefault}
        className="rounded-lg bg-cyan-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50">
        Зберегти як налаштування за замовчуванням
      </button>
      <div className="border-t border-slate-800 pt-4">
        <label className={label}>Назва власного пресета
          <input className={control} maxLength={40} value={presetName} placeholder="Наприклад, Скальпінг"
            onChange={event => { setPresetName(event.target.value); setError(''); }} />
        </label>
        <button type="button" disabled={busy} onClick={savePreset}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-950/50 px-4 py-2.5 text-xs font-semibold text-cyan-200 hover:border-cyan-400 disabled:opacity-50">
          <BookmarkPlus size={15} /> {editingId ? 'Оновити пресет' : 'Створити пресет'}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      {message && <p role="status" className="flex items-center gap-2 text-xs text-emerald-300"><CheckCircle2 size={14}/>{message}</p>}
    </section>

    <section className="space-y-3">
      <h4 className="text-sm font-semibold text-white">Мої пресети ({stored.presets?.length ?? 0}/{MAX_SCREENER_SEARCH_PRESETS})</h4>
      {(!stored.presets || stored.presets.length === 0) && <p className="text-xs text-slate-400">Ще немає збережених пресетів. Створіть перший у редакторі вище.</p>}
      {(stored.presets || []).map(item => <div key={item.id}
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-950/70 p-3">
        <div className="min-w-0">
          <div className="break-words text-sm font-semibold text-slate-100">{item.name}</div>
          <p className="mt-1 text-[11px] text-slate-400">
            {SCREENER_SEARCH_SORT_OPTIONS.find(option => option.value === item.config.sortBy)?.label ?? item.config.sortBy}
            {stored.defaultPresetId === item.id ? ' · За замовчуванням' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={() => choosePreset(item.id)}
            className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:border-cyan-500 disabled:opacity-50">Редагувати</button>
          <button type="button" disabled={busy || stored.defaultPresetId === item.id} onClick={() => defaultPreset(item.id)}
            className="rounded-lg border border-cyan-700/60 px-2.5 py-1.5 text-xs text-cyan-300 hover:border-cyan-400 disabled:opacity-50">Зробити стандартним</button>
          <button type="button" aria-label={'Видалити пресет ' + item.name} disabled={busy} onClick={() => removePreset(item.id)}
            className="rounded-lg border border-rose-900/50 p-1.5 text-rose-300 hover:bg-rose-950/50 disabled:opacity-50"><Trash2 size={15}/></button>
        </div>
      </div>)}
    </section>
  </div>;
}
