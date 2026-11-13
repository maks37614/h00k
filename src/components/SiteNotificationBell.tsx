import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, CheckCheck, Trash2, X, Settings2, TrendingUp, TrendingDown, ShieldAlert, Target, Activity } from 'lucide-react';
import { useSiteNotifications } from '../context/SiteNotificationsContext';
import type { SiteNotificationItem } from '../utils/siteNotifications';

const iconFor = (item: SiteNotificationItem) => item.kind === 'impulse'
  ? item.changePct !== undefined && item.changePct < 0 ? <TrendingDown className="h-4 w-4 text-rose-400" /> : <TrendingUp className="h-4 w-4 text-emerald-400" />
  : item.kind === 'price' ? <Target className="h-4 w-4 text-cyan-400" />
  : item.kind === 'surveillance' ? <ShieldAlert className="h-4 w-4 text-violet-400" />
  : <Activity className="h-4 w-4 text-amber-300" />;

export const SiteNotificationBell: React.FC<{ onOpenSettings?: () => void }> = ({ onOpenSettings }) => {
  const { items, unreadCount, markAllRead, clear, settings } = useSiteNotifications();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <button type="button" id="open-site-notifications-btn"
        onClick={() => setOpen(true)}
        aria-label={'Сповіщення на сайті, непрочитаних: ' + unreadCount}
        title="Центр сповіщень"
        className="relative inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 p-1.5 text-cyan-400 transition-colors hover:bg-slate-800 sm:p-2">
        <Bell className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        {unreadCount > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-0.5 text-[9px] font-bold text-white">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>}
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[110] flex items-start justify-center bg-slate-950/75 p-3 pt-[max(5vh,20px)] backdrop-blur-sm sm:justify-end sm:p-6"
          role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-label="Центр сповіщень"
            className="flex max-h-[85dvh] w-full max-w-[460px] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-700 bg-[#0e1728] text-slate-100 shadow-2xl">
            <header className="flex items-start justify-between gap-3 border-b border-slate-700/80 p-4">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-base font-bold">
                  <Bell className="h-4 w-4 text-cyan-300" /> Сповіщення
                  {unreadCount > 0 && <span className="rounded-full bg-cyan-500/15 px-2 py-0.5 text-xs text-cyan-300">{unreadCount}</span>}
                </h2>
                <p className="mt-1 text-xs text-slate-400">
                  {settings.enabled ? 'Цінові рівні, формації, імпульси та нагляд' : 'Сповіщення на сайті призупинено'}
                </p>
              </div>
              <button type="button" aria-label="Закрити сповіщення" onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-slate-300 hover:bg-slate-800"><X className="h-5 w-5" /></button>
            </header>
            <div className="flex flex-wrap gap-2 border-b border-slate-800 p-3 text-[11px]">
              <button type="button" onClick={markAllRead} disabled={!unreadCount}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 text-cyan-300 disabled:opacity-40"><CheckCheck className="h-3.5 w-3.5" /> Прочитано</button>
              <button type="button" onClick={clear} disabled={!items.length}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 text-rose-300 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /> Очистити</button>
              {onOpenSettings && <button type="button" onClick={() => { setOpen(false); onOpenSettings(); }}
                className="ml-auto inline-flex items-center gap-1 rounded-lg border border-cyan-700/60 px-2.5 py-1.5 text-cyan-300"><Settings2 className="h-3.5 w-3.5" /> Налаштувати</button>}
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              {!items.length ? <div className="px-3 py-12 text-center text-sm text-slate-400">
                Нових сповіщень поки немає. Створіть ціновий алерт або налаштуйте пошук імпульсів у профілі.
              </div> : items.map(item => (
                <article key={item.id} className={'flex gap-2.5 rounded-xl border p-3 ' +
                  (!item.read ? 'border-cyan-600/30 bg-cyan-950/25' : 'border-transparent bg-slate-900/50')}>
                  <div className="mt-0.5 shrink-0">{iconFor(item)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-1">
                      <h3 className="break-words text-xs font-semibold text-slate-100">{item.title}</h3>
                      <time className="whitespace-nowrap text-[10px] text-slate-500">
                        {new Date(item.timestamp).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })}
                      </time>
                    </div>
                    <p className="mt-1 break-words text-[11px] leading-relaxed text-slate-300">{item.description}</p>
                    {item.kind === 'impulse' && Number.isFinite(item.changePct) &&
                      <span className={'mt-1 inline-block rounded-md px-2 py-0.5 font-mono text-xs font-bold ' +
                        ((item.changePct || 0) >= 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300')}>
                        {(item.changePct || 0) > 0 ? '+' : ''}{item.changePct?.toFixed(2)}%
                      </span>}
                  </div>
                </article>
              ))}
            </div>
            <footer className="border-t border-slate-800 px-4 py-2 text-[10px] text-slate-500">
              Історія подій на цьому пристрої; історія цінових алертів також відновлюється із сервера.
            </footer>
          </section>
        </div>, document.body)}
    </>
  );
};
