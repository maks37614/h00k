import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplaySpeedPicker, REPLAY_SPEED_OPTIONS } from '../src/components/replay/ReplaySpeedPicker';

test('Replay speed selector preserves the original speed choices', () => {
  assert.deepEqual(REPLAY_SPEED_OPTIONS.map(option => option.value),
    [0.25, 0.5, 1, 2, 5, 10]);
});

test('Replay speed selector is accessible and reflects the chosen rate', () => {
  const html = renderToStaticMarkup(React.createElement(ReplaySpeedPicker, {
    speed: 2, onSpeedChange: () => {},
  }));
  assert.match(html, /aria-label="Швидкість відтворення"/);
  assert.match(html, /value="2" selected=""/);
  assert.ok(html.includes('0.25x') && html.includes('10x'));
});
