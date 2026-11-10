import React, { useCallback, useEffect, useState } from 'react';
import { Newspaper, RefreshCw } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import type { SupportedLanguage } from '../locales';

interface CryptoHeadline {
  title: string;
  url: string;
  publishedAt: string;
}

const UI: Record<SupportedLanguage, { heading: string; refresh: string; unavailable: string; empty: string; loading: string }> = {
  uk: { heading: 'Криптоновини', refresh: 'Оновити новини', unavailable: 'Наразі не вдалося отримати новини', empty: 'Новин поки немає', loading: 'Завантажуємо останні новини…' },
  en: { heading: 'Crypto news', refresh: 'Refresh news', unavailable: 'News are temporarily unavailable', empty: 'No news yet', loading: 'Loading latest news…' },
  ru: { heading: 'Криптоновости', refresh: 'Обновить новости', unavailable: 'Не удалось получить новости', empty: 'Новостей пока нет', loading: 'Загружаем последние новости…' },
  pl: { heading: 'Wiadomości krypto', refresh: 'Odśwież wiadomości', unavailable: 'Nie można teraz pobrać wiadomości', empty: 'Brak wiadomości', loading: 'Wczytywanie wiadomości…' },
};

export const CryptoNewsWidget: React.FC = () => {
  const { language } = useLanguage();
  const labels = UI[language];
  const [items, setItems] = useState<CryptoHeadline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const requestRefresh = useCallback(() => setRefresh(value => value + 1), []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      if (!active) return;
      setLoading(true);
      setError(false);
      try {
        const response = await fetch('/api/news/crypto?lang=' + encodeURIComponent(language), {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('News request failed');
        const data: { success?: boolean; items?: CryptoHeadline[] } = await response.json();
        if (!data.success || !Array.isArray(data.items)) throw new Error('Invalid news response');
        if (active) setItems(data.items);
      } catch (err) {
        if (active && !controller.signal.aborted) {
          setItems([]);
          setError(true);
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    setItems([]);
    void load();
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [language, refresh]);

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800/90 bg-slate-900/90 shadow-lg backdrop-blur-md" aria-label={labels.heading}>
      <header className="flex min-h-[64px] items-center justify-between gap-2 border-b border-slate-800/70 p-3 sm:p-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-cyan-500/25 bg-cyan-500/10 text-cyan-300">
            <Newspaper className="h-4 w-4" aria-hidden="true" />
          </div>
          <h3 className="truncate text-sm font-bold uppercase tracking-wider text-white sm:text-base">{labels.heading}</h3>
        </div>
        <button type="button" onClick={requestRefresh} disabled={loading} aria-label={labels.refresh}
          title={labels.refresh}
          className="shrink-0 rounded-lg border border-slate-700/60 bg-slate-800/80 p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white disabled:opacity-50">
          <RefreshCw className={'h-3.5 w-3.5 ' + (loading ? 'animate-spin' : '')} aria-hidden="true" />
        </button>
      </header>
      {loading && items.length === 0 ? (
        <div role="status" className="px-4 py-6 text-sm text-slate-400">{labels.loading}</div>
      ) : error ? (
        <div role="status" className="px-4 py-6 text-sm text-slate-400">{labels.unavailable}</div>
      ) : items.length === 0 ? (
        <div role="status" className="px-4 py-6 text-sm text-slate-400">{labels.empty}</div>
      ) : (
        <ul className="max-h-[360px] divide-y divide-slate-800/70 overflow-y-auto overscroll-contain" aria-label={labels.heading}>
          {items.map(item => (
            <li key={item.url + item.publishedAt}>
              <a href={item.url} target="_blank" rel="noopener noreferrer"
                data-no-translate
                className="block px-3.5 py-2.5 text-xs font-semibold leading-relaxed text-slate-200 transition-colors hover:bg-slate-800/60 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 sm:text-sm">
                {item.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
