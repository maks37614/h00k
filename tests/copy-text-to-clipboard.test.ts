import assert from 'node:assert/strict';
import test from 'node:test';
import { copyTextToClipboard } from '../src/utils/copyTextToClipboard';

test('copies the visible trading pair with the Clipboard API', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const received: string[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (value: string) => { received.push(value); } } } });
  try {
    assert.equal(await copyTextToClipboard('BTC/USDT'), true);
    assert.deepEqual(received, ['BTC/USDT']);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('returns false when browser clipboard facilities are unavailable', async () => {
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined });
  try {
    assert.equal(await copyTextToClipboard('BTC/USDT'), false);
  } finally {
    if (originalNav) Object.defineProperty(globalThis, 'navigator', originalNav);
    else Reflect.deleteProperty(globalThis, 'navigator');
    if (originalDoc) Object.defineProperty(globalThis, 'document', originalDoc);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
