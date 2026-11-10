import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeNewsLanguage, normalizeHeadlineLimit, selectLatestCryptoHeadlines, mergeCryptoHeadlineBatches } from '../server/cryptoNewsFeed';

const now = Date.parse('2026-11-10T00:00:00Z');

test('Crypto news keeps only recent real crypto headlines, sorted and safe to link', () => {
  const result = selectLatestCryptoHeadlines({ articles: [
    { title: 'General election discussion and world leaders', link: 'https://news.example/world', pubDate: '2026-11-09T23:59:00Z', category: 'mainstream' },
    { title: 'Bitcoin ETF records fresh inflows after market rally', link: 'https://news.example/btc', pubDate: '2026-11-09T23:30:00Z', category: 'mainstream' },
    { title: 'Ethereum staking update adds support for validators', link: 'https://news.example/eth', pubDate: '2026-11-09T23:50:00Z', category: 'ethereum' },
    { title: 'Ethereum staking update adds support for validators', link: 'https://news.example/duplicate', pubDate: '2026-11-09T23:40:00Z', category: 'ethereum' },
    { title: 'ETH Gas: average fee 0.01 Gwei updated', link: 'https://etherscan.io/gastracker', pubDate: '2026-11-09T23:59:00Z', category: 'ethereum', sourceKey: 'etherscan_gas' },
    { title: 'Solana ecosystem announces new network upgrades', link: 'javascript:alert(1)', pubDate: '2026-11-09T23:55:00Z', category: 'solana' },
    { title: 'Bitcoin protocol latest announcement and upgrade', link: 'https://news.example/old', pubDate: '2026-10-09T23:55:00Z', category: 'bitcoin' },
  ] }, now);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(a => a.url), ['https://news.example/eth', 'https://news.example/btc']);
  assert.ok(result.every(a => a.title && a.publishedAt));
});

test('News locale is constrained to the four site languages', () => {
  assert.equal(normalizeNewsLanguage('pl'), 'pl');
  assert.equal(normalizeNewsLanguage('ru'), 'ru');
  assert.equal(normalizeNewsLanguage('en'), 'en');
  assert.equal(normalizeNewsLanguage('uk'), 'uk');
  assert.equal(normalizeNewsLanguage('not-a-lang'), 'uk');
  assert.equal(normalizeNewsLanguage(['en']), 'uk');
});

test('Crypto news widget uses site language, displays only headlines, and does not alter Replay', () => {
  const widget = readFileSync(new URL('../src/components/CryptoNewsWidget.tsx', import.meta.url), 'utf8');
  const screener = readFileSync(new URL('../src/components/CoinScreenerPage.tsx', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(widget, /const \{ language \} = useLanguage\(\)/);
  assert.match(widget, /new URLSearchParams\(\{ lang: language, limit: String\(limit\) \}\)/);
  assert.match(widget, /\/api\/news\/crypto\?/);
  assert.match(widget, /data-no-translate/);
  assert.match(widget, /item\.title/);
  assert.doesNotMatch(widget, /item\.(?:description|source)/);
  assert.match(screener, /xl:grid-cols-2/);
  assert.match(screener, /<CryptoNewsWidget/);
  assert.match(server, /installCryptoNewsRoutes\(app\)/);
});

test('News API allows progressively showing up to 180 items without translating the entire feed', () => {
  assert.equal(normalizeHeadlineLimit(undefined), 4);
  assert.equal(normalizeHeadlineLimit('2'), 4);
  assert.equal(normalizeHeadlineLimit('18'), 18);
  assert.equal(normalizeHeadlineLimit('27'), 27);
  assert.equal(normalizeHeadlineLimit('999'), 180);
  assert.equal(normalizeHeadlineLimit('not-a-number'), 4);
  assert.equal(normalizeHeadlineLimit(['45']), 4);
  const feed = readFileSync(new URL('../server/cryptoNewsFeed.ts', import.meta.url), 'utf8');
  assert.match(feed, /const ARTICLE_COUNT = 180/);
  assert.match(feed, /const page = news.slice\(0, limit\)/);
  assert.match(feed, /hasMore: news.length > limit/);
});

test('News widget shows localized News title, more button and non-clickable headlines', () => {
  const widget = readFileSync(new URL('../src/components/CryptoNewsWidget.tsx', import.meta.url), 'utf8');
  assert.match(widget, /heading: 'Новини'/);
  assert.match(widget, /heading: 'News'/);
  assert.match(widget, /heading: 'Новости'/);
  assert.match(widget, /heading: 'Wiadomości'/);
  assert.match(widget, /flex h-\[346px\] min-w-0 flex-col overflow-hidden/);
  assert.match(widget, /ref=\{listRef\}/);
  assert.match(widget, /min-h-0 flex-1 divide-y divide-slate-800\/70 overflow-y-auto/);
  assert.match(widget, /h-\[56px\] shrink-0/);
  assert.match(widget, /list.scrollTop = Math.max\(0, next.offsetTop - first.offsetTop\)/);
  assert.match(widget, /onClick=\{showMore\}/);
  assert.match(widget, /<p data-no-translate/);
  assert.doesNotMatch(widget, /ExternalLink|target="_self"|target="_blank"|href=\{item.url\}/);
  assert.doesNotMatch(widget, /item\.(?:description|source|url)/);
});

test('News headline-only API does not leak article links to visitors', () => {
  const feed = readFileSync(new URL('../server/cryptoNewsFeed.ts', import.meta.url), 'utf8');
  const widget = readFileSync(new URL('../src/components/CryptoNewsWidget.tsx', import.meta.url), 'utf8');
  assert.match(feed, /const INITIAL_NEWS_COUNT = 4/);
  assert.match(feed, /items: items.map\(\(\{ title, publishedAt \}\) => \(\{ title, publishedAt \}\)\)/);
  assert.doesNotMatch(widget, /<a\s|<button[^>]*item\.title|ExternalLink|Читати новину|Read article/);
  assert.match(widget, /const PAGE_SIZE = 4/);
});

test('Crypto Vision JSON Feed 1.1 is supported alongside free topic endpoints', () => {
  const result = selectLatestCryptoHeadlines({ items: [
    {
      title: 'Bitcoin market records another record network milestone',
      external_url: 'https://example.com/bitcoin-network',
      url: 'https://cryptocurrency.cv/en/article/bitcoin-network',
      date_published: '2026-11-09T23:55:00Z',
      tags: ['cryptocurrency', 'bitcoin'],
    },
    {
      title: 'Unrelated general-election coverage and political results',
      url: 'https://cryptocurrency.cv/en/article/election',
      date_published: '2026-11-09T23:57:00Z',
      tags: ['cryptocurrency'],
    },
    {
      title: 'Ethereum expands capacity for rollups',
      url: 'https://cryptocurrency.cv/en/article/ethereum',
      date_published: '2026-11-09T23:52:00Z',
      tags: ['cryptocurrency', 'ethereum'],
    },
    {
      title: 'ETH Gas: standard price 0.1 Gwei',
      url: 'https://cryptocurrency.cv/en/article/ethgas',
      date_published: '2026-11-09T23:59:00Z',
      tags: ['cryptocurrency', 'ethereum'],
    },
  ] }, now);
  assert.equal(result.length, 2);
  assert.equal(result[0].url, 'https://example.com/bitcoin-network');
  assert.match(result[1].title, /Ethereum/);
});

test('Multiple free feeds and previous refreshes merge, deduplicate, and stay date-sorted', () => {
  const makeItem = (title: string, minute: number) => ({
    title,
    url: 'https://example.com/' + minute,
    publishedAt: new Date(now - minute * 60_000).toISOString(),
  });
  const merged = mergeCryptoHeadlineBatches([
    [makeItem('Bitcoin ETF rally', 4), makeItem('Ethereum upgrade', 2)],
    [makeItem('Bitcoin ETF rally', 4), makeItem('Solana dapps grow', 1)],
    [makeItem('Older news remains available', 20)],
  ], now);
  assert.deepEqual(merged.map(item => item.title), [
    'Solana dapps grow', 'Ethereum upgrade', 'Bitcoin ETF rally', 'Older news remains available',
  ]);
});

test('Screener news has more headline sources and continues paginating beyond 45', () => {
  const feed = readFileSync(new URL('../server/cryptoNewsFeed.ts', import.meta.url), 'utf8');
  const widget = readFileSync(new URL('../src/components/CryptoNewsWidget.tsx', import.meta.url), 'utf8');
  assert.match(feed, /https:\/\/cryptocurrency\.cv\/feed\.json/);
  assert.match(feed, /https:\/\/cryptocurrency\.cv\/api\/bitcoin/);
  assert.match(feed, /https:\/\/cryptocurrency\.cv\/api\/ethereum/);
  assert.match(feed, /https:\/\/cryptocurrency\.cv\/api\/defi/);
  assert.match(widget, /const MAX_HEADLINES = 180/);
  assert.match(widget, /onClick=\{showMore\}/);
  assert.match(widget, /const PAGE_SIZE = 4/);
  assert.doesNotMatch(widget, /href=\{item\./);
});

test('Four headlines with fixed-height panel and inner-only load-more scrolling', () => {
  const widget = readFileSync(new URL('../src/components/CryptoNewsWidget.tsx', import.meta.url), 'utf8');
  assert.match(widget, /const PAGE_SIZE = 4/);
  assert.match(widget, /limit: Math.min\(MAX_HEADLINES, limit \+ PAGE_SIZE\)/);
  assert.match(widget, /h-\[346px\]/);
  assert.match(widget, /h-\[56px\] shrink-0/);
  assert.match(widget, /ref=\{listRef\}/);
  assert.match(widget, /overflow-y-auto overscroll-contain/);
  assert.match(widget, /nextScrollIndex.current = items.length/);
  assert.doesNotMatch(widget, /h-\[460px\]|h-\[560px\]|h-\[640px\]/);
  assert.doesNotMatch(widget, /<a\s|href=\{item\./);
});

test('The news panel fits exactly four two-line headlines without a blank bottom area', () => {
  const widget = readFileSync(new URL('../src/components/CryptoNewsWidget.tsx', import.meta.url), 'utf8');
  // 2px section borders + 64px header + 4*56px headline rows + 56px footer.
  assert.equal(2 + 64 + 4 * 56 + 56, 346);
  assert.match(widget, /flex h-\[346px\] min-w-0 flex-col overflow-hidden/);
  assert.match(widget, /h-\[64px\] min-h-\[64px\] shrink-0/);
  assert.match(widget, /className="flex h-\[56px\] items-center overflow-hidden"/);
  assert.match(widget, /line-clamp-2 w-full/);
  assert.match(widget, /min-h-0 flex-1 divide-y divide-slate-800\/70 overflow-y-auto/);
  assert.match(widget, /h-\[56px\] shrink-0/);
  assert.match(widget, /onClick=\{showMore\}/);
  assert.doesNotMatch(widget, /h-\[410px\]/);
});
