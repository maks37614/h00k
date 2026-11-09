import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, doc, collection } from 'firebase/firestore';
import { Client, credentials } from '@grpc/grpc-js';

test('patched Firestore/React-client dependency graph initializes Auth and Firestore offline', async () => {
  // A throwaway, non-production Firebase project: this test must never send
  // requests to a real user database or use deployed credentials.
  const app = initializeApp({
    apiKey: 'offline-no-network-key',
    projectId: 'h00k-offline-test',
    appId: '1:000000000000:web:offline-ci',
    authDomain: 'offline.invalid',
  }, 'h00k-offline-audit');
  try {
    const auth = getAuth(app);
    const firestore = getFirestore(app);
    assert.equal(auth.app.name, app.name);
    assert.equal(doc(firestore, 'audit', 'canary').path, 'audit/canary');
    assert.equal(collection(firestore, 'audit').path, 'audit');
  } finally {
    await deleteApp(app);
  }
});

test('patched transitive grpc-js exposes stable client API and remains pinned in npm lockfile', () => {
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const installed = lock.packages['node_modules/@grpc/grpc-js']?.version;
  assert.equal(installed, '1.13.6');
  assert.equal(manifest.overrides?.['@grpc/grpc-js'], installed);
  assert.equal(lock.packages['node_modules/firebase']?.version, '12.19.0',
    'security patch must not downgrade Firebase');
  assert.equal(typeof credentials.createInsecure, 'function');
  const client = new Client('localhost:65535', credentials.createInsecure());
  client.close();
});
