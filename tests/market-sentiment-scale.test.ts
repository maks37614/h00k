import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clampSentimentScore, MarketSentimentScale } from '../src/components/MarketSentimentScale';

test('market sentiment score stays within the real 0–100 range', () => {
  assert.equal(clampSentimentScore(-15), 0);
  assert.equal(clampSentimentScore(23), 23);
  assert.equal(clampSentimentScore(100), 100);
  assert.equal(clampSentimentScore(124), 100);
  assert.equal(clampSentimentScore(Number.NaN), 0);
});

test('animated sentiment scale is accessible and mobile responsive', () => {
  const html = renderToStaticMarkup(React.createElement(MarketSentimentScale, {
    score: 23,
    sentimentLabel: 'Страх',
  }));
  assert.match(html, /data-market-sentiment-scale/);
  assert.match(html, /role="meter"/);
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="100"/);
  assert.match(html, /aria-valuenow="23"/);
  assert.match(html, /23 зі 100/);
  assert.match(html, /data-market-sentiment-marker/);
  assert.match(html, /motion-safe:duration-1000/);
  assert.match(html, /Страх/);
  assert.match(html, /Нейтрально/);
  assert.match(html, /Жадібність/);
});

test('scale remains visible before expanding the market mood details', () => {
  const src = readFileSync(new URL('../src/components/MarketSentimentWidget.tsx', import.meta.url), 'utf8');
  const meter = src.indexOf('<MarketSentimentScale score={data.compositeScore}');
  const details = src.indexOf('{expanded && (');
  assert.ok(meter > 0 && details > meter, 'gauge is always visible above the optional detail panel');
  assert.doesNotMatch(src, /\{data\.compositeScore\} \/ 100 • \{data\.sentimentLabel\}/, 'duplicate score and sentiment badge is removed');
  assert.match(src, /Настрій Ринку/, 'mood heading remains visible');
});
