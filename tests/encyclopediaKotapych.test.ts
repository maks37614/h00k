import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { FormationGuideModal } from '../src/components/FormationGuideModal';
import { KotapychGuide } from '../src/components/encyclopedia/KotapychGuide';
import { KOTAPYCH_SETUPS, KOTAPYCH_TOPICS } from '../src/components/encyclopedia/kotapychGuideData';
import { KOTAPYCH_SOURCE_PAGES } from '../src/components/encyclopedia/kotapychArchive';

test('main encyclopedia exposes both general categories and the Kotapych subcategory', () => {
  const html = renderToString(React.createElement(FormationGuideModal, { isOpen: true, onClose: () => {} }));
  assert.match(html, /Скальпінг/);
  assert.match(html, /Формації-Патерни/);
  assert.match(html, /Котапич/);
});

test('Kotapych has exactly four distinct setups and all structured detail sections', () => {
  assert.deepEqual(KOTAPYCH_SETUPS.map(item => item.id), ['setup1', 'setup2', 'setup3', 'setup4']);
  assert.deepEqual(KOTAPYCH_SETUPS.map(item => item.direction), ['LONG', 'SHORT', 'SHORT', 'LONG']);
  for (const setup of KOTAPYCH_SETUPS) {
    for (const key of ['context', 'recognition', 'entry', 'management', 'stop', 'targets', 'cancellation'] as const) {
      assert.ok(setup[key].length > 0, setup.id + ' should describe ' + key);
    }
    assert.ok(setup.source.includes('docx'));
  }
  assert.ok(KOTAPYCH_TOPICS.length >= 5);
});

test('both complete source document transcripts are indexed and remain accessible', () => {
  const large = KOTAPYCH_SOURCE_PAGES.filter(page => page.source === 'Копатыч.docx');
  const short = KOTAPYCH_SOURCE_PAGES.filter(page => page.source === '4 set.docx');
  assert.equal(large.length, 79);
  assert.equal(short.length, 8);
  assert.deepEqual(large.map(x => x.page), Array.from({ length: 79 }, (_, i) => i + 1));
  assert.deepEqual(short.map(x => x.page), Array.from({ length: 8 }, (_, i) => i + 1));
  assert.ok(large.reduce((length, x) => length + x.text.length, 0) > 70000);
  assert.ok(short.reduce((length, x) => length + x.text.length, 0) > 5000);
  assert.ok(short.some(x => x.text.includes('Сетап №1:')));
  assert.ok(short.some(x => x.text.includes('Сетап №2:')));
  assert.ok(short.some(x => x.text.includes('Сетап №3:')));
  assert.ok(short.some(x => x.text.includes('Сетап №4:')));
});

test('Kotapych guide renders structured Ukrainian navigation', () => {
  const html = renderToString(React.createElement(KotapychGuide));
  for (const name of ['Сетап №1', 'Сетап №2', 'Сетап №3', 'Сетап №4', 'Поглиблений аналіз']) {
    assert.ok(html.includes(name), name + ' tab missing');
  }
  assert.match(html, /LONG/);
  assert.match(html, /SHORT/);
  assert.match(html, /Не є індивідуальною інвестиційною рекомендацією/);
});

test('all key concepts from both documents are covered before hiding raw-notes navigation', () => {
  const topicIds = KOTAPYCH_TOPICS.map(topic => topic.id);
  const required = [
    'market-context', 'bases-levels', 'base-secondary', 'liquidity-sweeps',
    'retest-rounding', 'setup1-variants', 'setup2-variants', 'setup3-pump',
    'setup4-pit', 'tape-orderbook', 'volume-clusters', 'execution-sizing',
    'stops-targets', 'chop-avoidance', 'transitions', 'funding-spot-futures',
    'instrument-selection', 'daily-risk', 'journal-psychology',
  ];
  assert.deepEqual(topicIds, required, 'important concepts must remain accessible');
  for (const topic of KOTAPYCH_TOPICS) {
    assert.ok(topic.points.length >= 6, topic.id + ' must include substantive detail');
    assert.ok(topic.notePages.length >= 5, topic.id + ' must cite original note pages');
    assert.ok(topic.points.every(text => text.trim().length >= 60), topic.id + ' has an incomplete explanation');
  }
  const markup = renderToString(React.createElement(KotapychGuide));
  assert.doesNotMatch(markup, /Повні нотатки|Повний текст наданих матеріалів|Оригінал/);
  assert.ok(markup.includes('Поглиблений аналіз'));
});

test('raw document transcripts are retained in the repository for future verification', () => {
  const count = KOTAPYCH_SOURCE_PAGES.length;
  assert.equal(count, 87);
});
