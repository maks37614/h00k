import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeNewsLanguage, normalizeHeadlineLimit, selectLatestCryptoHeadlines } from '../server/cryptoNewsFeed';

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
  assert.match(widget, /\/api\/news\/crypto\?lang=/);
  assert.match(widget, /data-no-translate/);
  assert.match(widget, /item\.title/);
  assert.doesNotMatch(widget, /item\.(?:description|source)/);
  assert.match(screener, /xl:grid-cols-2/);
  assert.match(screener, /<CryptoNewsWidget/);
  assert.match(server, /installCryptoNewsRoutes\(app\)/);
});

test('News API allows progressively showing up to 45 items without translating the entire feed', () => {
  assert.equal(normalizeHeadlineLimit(undefined), 9);
  assert.equal(normalizeHeadlineLimit('18'), 18);
  assert.equal(normalizeHeadlineLimit('27'), 27);
  assert.equal(normalizeHeadlineLimit('999'), 45);
  assert.equal(normalizeHeadlineLimit('not-a-number'), 9);
  assert.equal(normalizeHeadlineLimit(['45']), 9);
  const feed = readFileSync(new URL('../server/cryptoNewsFeed.ts', import.meta.url), 'utf8');
  assert.match(feed, /const ARTICLE_COUNT = 45/);
  assert.match(feed, /const page = news.slice\(0, limit\)/);
  assert.match(feed, /hasMore: news.length > limit/);
});

test('News widget shows localized News title, more button and working same-tab article links', () => {
  const widget = readFileSync(new URL('../src/components/CryptoNewsWidget.tsx', import.meta.url), 'utf8');
  assert.match(widget, /heading: 'Новини'/);
  assert.match(widget, /heading: 'News'/);
  assert.match(widget, /heading: 'Новости'/);
  assert.match(widget, /heading: 'Wiadomości'/);
  assert.match(widget, /max-h-\[520px\]/);
  assert.match(widget, /onClick=\{showMore\}/);
  assert.match(widget, /target="_self"/);
  assert.match(widget, /href=\{item.url\}/);
  assert.doesNotMatch(widget, /target="_blank"/);
  assert.doesNotMatch(widget, /item\.(?:description|source)/);
});
