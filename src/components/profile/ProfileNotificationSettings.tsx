import React, { useEffect, useState } from 'react';
import { Bell, BellOff, Volume2, Play, Activity, Target, ShieldAlert, TrendingUp, Save, AlertTriangle } from 'lucide-react';
import { useSiteNotifications } from '../context/SiteNotificationsContext';
import { normalizeImpulseSymbol, type SiteNotificationSettings } from '../utils/siteNotifications';
import { playSiteNotificationSound } from '../utils/domSound';

const Row: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (enabled: boolean) => void;
}> = ({ icon, title, description, checked, onChange }) => (
  <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-slate-700/70 bg-slate-950/70 p-3">
    <span className="flex min-w-0 items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-cyan-400">{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-slate-100">{title}</span>
        <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">{description}</span>
      </span>
    </span>
    <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)}
      className="h-4 w-4 shrink-0 cursor-pointer accent-cyan-400" />
  </label>
);

export const ProfileNotificationSettings: React.FC = () => {
  const { settings, updateSettings, soundEnabled, setSoundEnabled, error } = useSiteNotifications();
  const [symbol, setSymbol] = useState(settings.impulseSymbol.replace(/USDT$/, ''));
  const [threshold, setThreshold] = useState(String(settings.impulseThresholdPct));
  const [formError, setFormError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setSymbol(settings.impulseSymbol.replace(/USDT$/, ''));
    setThreshold(String(settings.impulseThresholdPct));
  }, [settings.impulseSymbol, settings.impulseThresholdPct]);

  const toggle = (key: keyof Pick<SiteNotificationSettings,
    'enabled' | 'price' | 'formations' | 'impulses' | 'surveillance'>, value: boolean) => {
    void updateSettings({ [key]: value });
  };
  const saveImpulse = () => {
    setSaved(false);
    const clean = normalizeImpulseSymbol(symbol);
    const pct = Number(threshold.replace(',', '.'));
    if (!clean) { setFormError('Введіть правильну монету, наприклад BTC або BTCUSDT.'); return; }
    if (!Number.isFinite(pct) || pct < 0.1 || pct > 50) {
      setFormError('Вкажіть поріг імпульсу від 0,1% до 50%.');
      return;
    }
    setFormError('');
    void updateSettings({ impulseSymbol: clean, impulseThresholdPct: pct, impulses: true });
    setSaved(true);
  };

  return (
    <section className="space-y-4" aria-label="Налаштування сповіщень">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-100">
          <Bell className="h-4 w-4 text-cyan-400" /> Сповіщення на сайті
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Події показуються за іконкою дзвіночка у верхньому меню. Вимкнення сповіщень на сайті
          не вимикає вже створені серверні Telegram-алерти.
        </p>
      </div>
      <Row icon={<Bell className="h-4 w-4" />} title="Усі сповіщення на сайті"
        description="Головний перемикач центру сповіщень." checked={settings.enabled}
        onChange={value => toggle('enabled', value)} />
      <div className={!settings.enabled ? 'space-y-2 opacity-60' : 'space-y-2'}>
        <Row icon={<Target className="h-4 w-4" />} title="Цінові алерти"
          description="Досягнення заданої ціни, входу, стопа або цілі."
          checked={settings.price} onChange={value => toggle('price', value)} />
        <Row icon={<Activity className="h-4 w-4" />} title="Нові сильні формації"
          description="Нові формації з оцінкою сигналу від 88/100 під час сканування."
          checked={settings.formations} onChange={value => toggle('formations', value)} />
        <Row icon={<ShieldAlert className="h-4 w-4" />} title="Системний нагляд"
          description="Події монет, які ви додали до розділу «Стеження за монетою»."
          checked={settings.surveillance} onChange={value => toggle('surveillance', value)} />
        <Row icon={<TrendingUp className="h-4 w-4" />} title="Імпульси та волатильність"
          description="Швидкі зміни ціни вибраної монети за визначений проміжок."
          checked={settings.impulses} onChange={value => toggle('impulses', value)} />
      </div>

      <div className="space-y-3 rounded-xl border border-cyan-700/30 bg-slate-950/70 p-3">
        <h4 className="flex items-center gap-2 text-xs font-bold text-slate-100">
          <TrendingUp className="h-4 w-4 text-cyan-300" /> Пошук імпульсів
        </h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-slate-300">
            <span>Назва монети</span>
            <input type="text" value={symbol} onChange={event => { setSymbol(event.target.value.toUpperCase()); setSaved(false); }}
              placeholder="BTC, ETH, SOL..." maxLength={30}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none" />
          </label>
          <label className="space-y-1 text-xs text-slate-300">
            <span>Мінімальна зміна ціни (%)</span>
            <input type="text" inputMode="decimal" value={threshold}
              onChange={event => { setThreshold(event.target.value); setSaved(false); }}
              placeholder="2" className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none" />
          </label>
          <label className="space-y-1 text-xs text-slate-300">
            <span>Біржа</span>
            <select value={settings.impulseExchange} onChange={event => void updateSettings({ impulseExchange: event.target.value as 'binance' | 'bybit' })}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">
              <option value="binance">Binance</option><option value="bybit">Bybit</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-300">
            <span>Ринок</span>
            <select value={settings.impulseMarket} onChange={event => void updateSettings({ impulseMarket: event.target.value as 'futures' | 'spot' })}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">
              <option value="futures">Ф'ючерси</option><option value="spot">Спот</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-300 sm:col-span-2">
            <span>Вікно вимірювання</span>
            <select value={settings.impulseWindowMinutes} onChange={event => void updateSettings({ impulseWindowMinutes: Number(event.target.value) as 1 | 5 | 15 })}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">
              <option value={1}>1 хвилина</option><option value={5}>5 хвилин</option><option value={15}>15 хвилин</option>
            </select>
          </label>
        </div>
        {formError && <p className="flex gap-1 text-xs text-rose-300" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" />{formError}</p>}
        {saved && !formError && <p className="text-xs text-emerald-300" role="status">Пошук імпульсів збережено та увімкнено.</p>}
        <button type="button" onClick={saveImpulse} className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-bold text-white hover:bg-cyan-500">
          <Save className="h-3.5 w-3.5" /> Зберегти та ввімкнути
        </button>
        <p className="text-[11px] leading-relaxed text-slate-400">
          Відстеження імпульсів працює через WebSocket, поки сайт відкрито.
          Для точного розрахунку потрібна накопичена історія цін у вибраному вікні.
          Повторне сповіщення обмежене одним за це вікно. Це не серверний моніторинг 24/7.
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-slate-700/70 bg-slate-950/70 p-3">
        <h4 className="flex items-center gap-2 text-xs font-bold text-slate-100">
          {soundEnabled ? <Volume2 className="h-4 w-4 text-cyan-400" /> : <BellOff className="h-4 w-4 text-slate-400" />}
          Звуки сповіщень
        </h4>
        <Row icon={<Volume2 className="h-4 w-4" />} title="Відтворювати звук"
          description="Загальний перемикач усіх звукових сповіщень сайту."
          checked={soundEnabled} onChange={value => void setSoundEnabled(value)} />
        <label className="block space-y-1 text-xs text-slate-300">
          <span>Мелодія</span>
          <select value={settings.sound} onChange={event => void updateSettings({ sound: event.target.value as SiteNotificationSettings['sound'] })}
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">
            <option value="chime">Дзвін · три ноти</option>
            <option value="soft">М'який сигнал</option>
            <option value="pulse">Подвійний імпульс</option>
          </select>
        </label>
        <button type="button" onClick={() => playSiteNotificationSound(settings.sound)}
          className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/40 px-3 py-2 text-xs text-cyan-300 hover:bg-cyan-950/40">
          <Play className="h-4 w-4" /> Прослухати
        </button>
        <p className="text-[11px] text-slate-500">На iPhone та інших пристроях звук залежить від дозволів браузера і режиму без звуку.</p>
      </div>
      {error && <p className="rounded-lg border border-rose-500/30 p-3 text-xs text-rose-300" role="alert">{error}</p>}
    </section>
  );
};
