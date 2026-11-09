import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplayFullscreenActions } from '../src/components/replay/ReplayFullscreenActions';

const callbacks = {
  onTogglePlay: () => {},
  onStepForward: () => {},
  onRandomHistoricalDate: () => {},
};

test('Replay fullscreen displays accessible Play, +1 candle, and Random date icons', () => {
  const html = renderToStaticMarkup(React.createElement(ReplayFullscreenActions, {
    ...callbacks, isPlaying: false, isLoading: false, canAdvance: true,
  }));
  assert.match(html, /aria-label="Повноекранне керування відтворенням"/);
  assert.match(html, /aria-label="Відтворити"/);
  assert.match(html, /aria-label="\+1 свічка"/);
  assert.match(html, /aria-label="Випадкова дата"/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.doesNotMatch(html, / disabled=""/);
});

const isDisabled = (html: string, label: string) => {
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
  const target = buttons.find(button => button.includes(`aria-label="${label}"`));
  assert.ok(target, `Button ${label} should be rendered`);
  return target.includes('disabled=""');
};

test('Replay fullscreen displays Pause and prevents stepping while playing', () => {
  const html = renderToStaticMarkup(React.createElement(ReplayFullscreenActions, {
    ...callbacks, isPlaying: true, isLoading: false, canAdvance: true,
  }));
  assert.match(html, /aria-label="Пауза"/);
  assert.doesNotMatch(html, /aria-label="Відтворити"/);
  assert.equal(isDisabled(html, 'Пауза'), false);
  assert.equal(isDisabled(html, '+1 свічка'), true);
  assert.equal(isDisabled(html, 'Випадкова дата'), false);
});

test('Replay fullscreen disables playback when history is loading or finished', () => {
  for (const options of [
    { isPlaying: false, isLoading: true, canAdvance: true },
    { isPlaying: false, isLoading: false, canAdvance: false },
  ]) {
    const html = renderToStaticMarkup(React.createElement(ReplayFullscreenActions, {
      ...callbacks, ...options,
    }));
    assert.equal(isDisabled(html, 'Відтворити'), true);
    assert.equal(isDisabled(html, '+1 свічка'), true);
    assert.equal(isDisabled(html, 'Випадкова дата'), options.isLoading);
  }
});
