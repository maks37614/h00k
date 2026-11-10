import type { Express } from 'express';
import type { SupportedLanguage } from '../src/locales';

// A public, rate-friendly server-side proxy. No new API keys are needed.
// Do not request translations per viewer: both source items and title
// translations are shared by all h00k visitors.
export type CryptoNewsHeadline = { title: string; url: string; publishedAt: string };
// The anonymous /api/news route is limited to three articles. Instead use
// the uncapped 50-entry JSON Feed alongside free topic feeds, then deduplicate.
const CRYPTO_VISION_SOURCES = [
  'https://cryptocurrency.cv/feed.json',
  'https://cryptocurrency.cv/api/bitcoin?limit=100',
  'https://cryptocurrency.cv/api/ethereum?limit=100',
  'https://cryptocurrency.cv/api/defi?limit=100',
] as const;
const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';
const SOURCE_TTL_MS = 5 * 60_000;
const SOURCE_STALE_MS = 60 * 60_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const ARTICLE_COUNT = 180;
const INITIAL_NEWS_COUNT = 20;

/** Cap each public request; client progressively unlocks more headlines. */
export function normalizeHeadlineLimit(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) return INITIAL_NEWS_COUNT;
  return Math.max(INITIAL_NEWS_COUNT, Math.min(ARTICLE_COUNT, Number(value)));
}

const CRYPTO_TERMS = /\b(?:bitcoin|btc|ethereum|ether|eth|solana|sol|crypto(?:currency|currencies)?|blockchain|web3|defi|stablecoin|usdt|usdc|altcoin|memecoin|tokeniz(?:ation|ed|ing)?|coinbase|binance|kraken|ripple|xrp|dogecoin|cardano|polkadot|avalanche|chainlink|bitget|okx|bybit|tether|microstrategy|satoshi|metamask|digital assets?|spot etf)\b/i;
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeBasicEntities(input: string) {
  return input.replace(/&(?:amp|quot|apos|lt|gt|#39|#x27);/gi, match => {
    const entities: Record<string, string> = {
      '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<',
      '&gt;': '>', '&#39;': "'", '&#x27;': "'",
    };
    return entities[match.toLowerCase()] ?? match;
  });
}

/** Keep the latest genuine crypto headlines; reject unrelated mainstream articles, stats and unsafe links. */
export function selectLatestCryptoHeadlines(payload: unknown, now = Date.now()): CryptoNewsHeadline[] {
  const raw = isObject(payload) && Array.isArray(payload.articles) ? payload.articles
    : isObject(payload) && Array.isArray(payload.items) ? payload.items : [];
  const results: CryptoNewsHeadline[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!isObject(value) || typeof value.title !== 'string') continue;
    const rawUrl = typeof value.external_url === 'string' ? value.external_url
      : typeof value.link === 'string' ? value.link
      : typeof value.url === 'string' ? value.url : '';
    if (!rawUrl) continue;
    const title = decodeBasicEntities(value.title.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
    if (title.length < 12 || title.length > 260 || /(?:gas price|gas tracker|funding rate\s*:)/i.test(title)) continue;
    if (typeof value.sourceKey === 'string' && /(?:_gas|_ticker|_price)$/.test(value.sourceKey)) continue;
    let target: URL;
    try {
      target = new URL(rawUrl);
      if (!['https:', 'http:'].includes(target.protocol)) continue;
    } catch { continue; }
    const dateText = typeof value.pubDate === 'string' ? value.pubDate : value.date_published;
    const stamp = typeof dateText === 'string' ? Date.parse(dateText) : NaN;
    if (!Number.isFinite(stamp) || stamp > now + 5 * 60_000 || stamp < now - MAX_AGE_MS) continue;
    const description = typeof value.description === 'string' ? value.description
      : typeof value.summary === 'string' ? value.summary : '';
    // A broad "cryptocurrency" tag alone must not admit unrelated AI,
    // politics or stock-market headlines into this crypto news module.
    if (!CRYPTO_TERMS.test(title + ' ' + description)) continue;
    if (/\b(?:promo code|betting bonus|sportsbook|free bets)\b/i.test(title)) continue;
    const key = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') ||
      target.hostname + target.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ title, url: target.href, publishedAt: new Date(stamp).toISOString() });
  }
  return results.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, ARTICLE_COUNT);
}

/** Accumulate recent items across feed refreshes so readers can load older news. */
export function mergeCryptoHeadlineBatches(
  batches: CryptoNewsHeadline[][],
  now = Date.now(),
): CryptoNewsHeadline[] {
  const seen = new Set<string>();
  const result: CryptoNewsHeadline[] = [];
  for (const item of batches.flat()) {
    const timestamp = Date.parse(item.publishedAt);
    if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60_000 || timestamp < now - MAX_AGE_MS) continue;
    const key = item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, ARTICLE_COUNT);
}

let sourceCache: { articles: CryptoNewsHeadline[]; updated: number } | null = null;
let sourceInFlight: Promise<CryptoNewsHeadline[]> | null = null;

async function latestNews(): Promise<CryptoNewsHeadline[]> {
  const now = Date.now();
  if (sourceCache && now - sourceCache.updated < SOURCE_TTL_MS) return sourceCache.articles;
  if (sourceInFlight) return sourceInFlight;

  sourceInFlight = (async () => {
    try {
      // One shared fetch per refresh interval, regardless of site traffic.
      // One feed failing should not blank the others.
      const batches = await Promise.allSettled(CRYPTO_VISION_SOURCES.map(async url => {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(9_000),
        });
        if (!response.ok) throw new Error('Crypto Vision returned ' + response.status);
        return selectLatestCryptoHeadlines(await response.json());
      }));
      const fresh = batches
        .filter((batch): batch is PromiseFulfilledResult<CryptoNewsHeadline[]> => batch.status === 'fulfilled')
        .map(batch => batch.value);
      if (!fresh.length) throw new Error('All Crypto Vision feeds unavailable');
      const articles = mergeCryptoHeadlineBatches([
        ...fresh,
        ...(sourceCache ? [sourceCache.articles] : []),
      ]);
      if (!articles.length) throw new Error('No recent crypto headlines available');
      sourceCache = { articles, updated: Date.now() };
      return articles;
    } catch (err) {
      if (sourceCache && Date.now() - sourceCache.updated < SOURCE_STALE_MS) return sourceCache.articles;
      throw err;
    }
  })().finally(() => { sourceInFlight = null; });

  return sourceInFlight;
}

const translationCache = new Map<string, string>();
const translationInFlight = new Map<string, Promise<string>>();
let dailyTranslationBudget = { date: '', characters: 0 };

export function normalizeNewsLanguage(input: unknown): SupportedLanguage {
  return input === 'pl' || input === 'ru' || input === 'en' ? input : 'uk';
}

function spendFreeTranslationBudget(title: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (dailyTranslationBudget.date !== day) dailyTranslationBudget = { date: day, characters: 0 };
  const contact = process.env.MYMEMORY_CONTACT_EMAIL;
  // MyMemory: 5k anonymous / 50k with a valid contact address. Leave headroom.
  const budget = contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? 45_000 : 4_500;
  const size = title.length;
  if (dailyTranslationBudget.characters + size > budget) return false;
  dailyTranslationBudget.characters += size;
  return true;
}

async function localizeTitle(title: string, language: SupportedLanguage): Promise<string> {
  if (language === 'en') return title;
  const key = language + ':' + title;
  const cached = translationCache.get(key);
  if (cached) return cached;
  const pending = translationInFlight.get(key);
  if (pending) return pending;
  if (Buffer.byteLength(title, 'utf8') > 490 || !spendFreeTranslationBudget(title)) return title;

  const promise = (async () => {
    try {
      const url = new URL(MYMEMORY_URL);
      url.searchParams.set('q', title);
      url.searchParams.set('langpair', 'en|' + language);
      const email = process.env.MYMEMORY_CONTACT_EMAIL;
      if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) url.searchParams.set('de', email);
      const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
      if (!response.ok) return title;
      const data: unknown = await response.json();
      if (!isObject(data) || Number(data.responseStatus) !== 200 || data.quotaFinished) return title;
      const result = isObject(data.responseData) ? data.responseData.translatedText : null;
      if (typeof result !== 'string' || !result.trim() || /^(?:my.?memory warning|quota exceeded)/i.test(result)) return title;
      const translated = decodeBasicEntities(result.trim());
      translationCache.set(key, translated);
      if (translationCache.size > 3000) translationCache.delete(translationCache.keys().next().value!);
      return translated;
    } catch { return title; }
  })().finally(() => { translationInFlight.delete(key); });
  translationInFlight.set(key, promise);
  return promise;
}

/** Limit concurrency for the free translator; preserve headline ordering. */
async function localizedNews(articles: CryptoNewsHeadline[], language: SupportedLanguage) {
  const items: CryptoNewsHeadline[] = [];
  for (let i = 0; i < articles.length; i += 3) {
    const group = articles.slice(i, i + 3);
    const titles = await Promise.all(group.map(article => localizeTitle(article.title, language)));
    group.forEach((article, index) => items.push({ ...article, title: titles[index] }));
  }
  return items;
}

export function installCryptoNewsRoutes(app: Express) {
  app.get('/api/news/crypto', async (req, res) => {
    const language = normalizeNewsLanguage(req.query.lang);
    try {
      const news = await latestNews();
      const limit = normalizeHeadlineLimit(req.query.limit);
      // Translate only the requested number of titles, not the entire feed.
      // The shared translation cache prevents repeat requests for earlier pages.
      const page = news.slice(0, limit);
      const items = language === 'en' ? page : await localizedNews(page, language);
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      // Headlines-only public response: do not expose article destinations.
      res.json({
        success: true,
        language,
        items: items.map(({ title, publishedAt }) => ({ title, publishedAt })),
        hasMore: news.length > limit,
      });
    } catch (error) {
      console.warn('[crypto-news] Feed currently unavailable:', error);
      res.status(503).json({ success: false, language, items: [], error: 'News are temporarily unavailable' });
    }
  });
}
