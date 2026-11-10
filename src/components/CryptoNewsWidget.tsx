import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Newspaper, RefreshCw } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import type { SupportedLanguage } from '../locales';

interface CryptoHeadline {
  title: string;
  publishedAt: string;
}

interface HeadlinesResponse {
  language: SupportedLanguage;
  items: CryptoHeadline[];
  hasMore: boolean;
  limit: number;
}

const PAGE_SIZE = 4;
const MAX_HEADLINES = 180;

const UI: Record<SupportedLanguage, {
  heading: string; refresh: string; unavailable: string; empty: string;
  loading: string; showMore: string; noMore: string;
}> = {
  uk: {
    heading: 'Новини',
    refresh: 'Оновити новини',
    unavailable: 'Наразі не вдалося отримати новини',
    empty: 'Новин поки немає',
    loading: 'Завантажуємо останні новини…',
    showMore: 'Показати ще новини',
    noMore: 'Більше новин поки немає',
  },
  en: {
    heading: 'News',
    refresh: 'Refresh news',
    unavailable: 'News are temporarily unavailable',
    empty: 'No news yet',
    loading: 'Loading latest news…',
    showMore: 'Show more news',
    noMore: 'No more news available',
  },
  ru: {
    heading: 'Новости',
    refresh: 'Обновить новости',
    unavailable: 'Не удалось получить новости',
    empty: 'Новостей пока нет',
    loading: 'Загружаем последние новости…',
    showMore: 'Показать больше новостей',
    noMore: 'Больше новостей пока нет',
  },
  pl: {
    heading: 'Wiadomości',
    refresh: 'Odśwież wiadomości',
    unavailable: 'Nie można teraz pobrać wiadomości',
    empty: 'Brak wiadomości',
    loading: 'Wczytywanie wiadomości…',
    showMore: 'Pokaż więcej wiadomości',
    noMore: 'Na razie brak kolejnych wiadomości',
  },
};

export const CryptoNewsWidget: React.FC = () => {
  const { language } = useLanguage();
  const labels = UI[language];
  // Switching languages starts with the latest four news, without showing
  // any headlines cached from the preceding language during the request.
  const [page, setPage] = useState({ language, limit: PAGE_SIZE });
  const limit = page.language === language ? page.limit : PAGE_SIZE;
  const [received, setReceived] = useState<HeadlinesResponse | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const nextScrollIndex = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const items = received?.language === language ? received.items.slice(0, limit) : [];
  const hasMore = received?.language === language && received.hasMore;

  const requestRefresh = useCallback(() => setRefresh(value => value + 1), []);
  const showMore = () => {
    nextScrollIndex.current = items.length;
    setPage({ language, limit: Math.min(MAX_HEADLINES, limit + PAGE_SIZE) });
  };

  // Reveal the first newly added headline inside the scroll container,
  // never by scrolling the Screener page itself.
  useEffect(() => {
    const index = nextScrollIndex.current;
    if (index === null || loading || received?.language !== language || received.limit !== limit) return;
    nextScrollIndex.current = null;
    const list = listRef.current;
    const first = list?.firstElementChild as HTMLElement | null;
    const next = list?.children.item(index) as HTMLElement | null;
    if (list && first && next) list.scrollTop = Math.max(0, next.offsetTop - first.offsetTop);
  }, [items.length, language, limit, loading, received]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      if (!active) return;
      setLoading(true);
      setError(false);
      try {
        const query = new URLSearchParams({ lang: language, limit: String(limit) });
        const response = await fetch('/api/news/crypto?' + query, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('News request failed');
        const data: { success?: boolean; items?: CryptoHeadline[]; hasMore?: boolean } = await response.json();
        if (!data.success || !Array.isArray(data.items)) throw new Error('Invalid news response');
        if (active) setReceived({ language, limit, items: data.items, hasMore: data.hasMore === true });
      } catch {
        if (active && !controller.signal.aborted) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [language, limit, refresh]);

  return (
    <section className="flex h-[410px] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-800/90 bg-slate-900/90 shadow-lg backdrop-blur-md" aria-label={labels.heading}>
      <header className="flex min-h-[64px] shrink-0 items-center justify-between gap-2 border-b border-slate-800/70 p-3 sm:p-4">
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
        <div role="status" className="min-h-0 flex-1 px-4 py-6 text-sm text-slate-400">{labels.loading}</div>
      ) : error && items.length === 0 ? (
        <div role="status" className="min-h-0 flex-1 px-4 py-6 text-sm text-slate-400">{labels.unavailable}</div>
      ) : items.length === 0 ? (
        <div role="status" className="min-h-0 flex-1 px-4 py-6 text-sm text-slate-400">{labels.empty}</div>
      ) : (
        <ul ref={listRef}
          className="min-h-0 flex-1 divide-y divide-slate-800/70 overflow-y-auto overscroll-contain"
          aria-label={labels.heading}>
          {items.map(item => (
            <li key={item.title + item.publishedAt}>
              <p data-no-translate
                className="px-3.5 py-2.5 text-xs font-semibold leading-relaxed text-slate-200 sm:text-sm">
                {item.title}
              </p>
            </li>
          ))}
        </ul>
      )}
      {/* Fixed footer: loading more can never stretch the panel. */}
      <div className="flex h-[56px] shrink-0 items-center border-t border-slate-800/70 p-2.5">
        {hasMore && limit < MAX_HEADLINES ? (
          <button type="button" disabled={loading} onClick={showMore}
            className="w-full rounded-lg border border-cyan-700/40 bg-slate-800/70 px-3 py-2.5 text-xs font-bold text-cyan-300 transition-colors hover:bg-slate-700/75 disabled:cursor-wait disabled:opacity-60">
            {loading ? labels.loading : labels.showMore}
          </button>
        ) : (
          <span className="w-full text-center text-xs text-slate-500">{labels.noMore}</span>
        )}
      </div>
      {error && items.length > 0 && (
        <span role="status" className="sr-only">{labels.unavailable}</span>
      )}
    </section>
  );
};
