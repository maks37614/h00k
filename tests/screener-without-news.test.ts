import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Screener has no crypto news widget and Market Sentiment remains available', () => {
  const screener = source('../src/components/CoinScreenerPage.tsx');
  assert.doesNotMatch(screener, /CryptoNewsWidget|\bnews\/crypto\b|Показати ще новини/);
  assert.match(screener, /<MarketSentimentWidget coins=\{coins\}/);
  assert.doesNotMatch(screener, /xl:grid-cols-2/);
  assert.equal(existsSync(new URL('../src/components/CryptoNewsWidget.tsx', import.meta.url)), false);
});

test('News request, translation and server startup dependencies are removed', () => {
  const server = source('../server.ts');
  const env = source('../.env.example');
  assert.doesNotMatch(server, /installCryptoNewsRoutes|server\/cryptoNewsFeed|\/api\/news\/crypto/);
  assert.equal(existsSync(new URL('../server/cryptoNewsFeed.ts', import.meta.url)), false);
  assert.doesNotMatch(env, /MYMEMORY_CONTACT_EMAIL/);
  assert.equal(existsSync(new URL('./crypto-news-feed.test.ts', import.meta.url)), false);
});

test('News removal keeps independent market sentiment and surveillance intact', () => {
  const screener = source('../src/components/CoinScreenerPage.tsx');
  const sentiment = source('../src/components/MarketSentimentWidget.tsx');
  const surveillance = source('../server/surveillance/macroAndNewsEngine.ts');
  assert.match(screener, /MarketSentimentWidget/);
  assert.match(sentiment, /\/api\/market\/sentiment/);
  assert.match(surveillance, /class MacroAndNewsEngine/);
});
