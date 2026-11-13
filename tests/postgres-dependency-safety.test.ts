import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = new URL('../', import.meta.url);
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?|cjs|mjs)$/.test(entry.name) ? [full] : [];
  });
}

test('authentication only uses PostgreSQL and no Firebase files or imports survive', () => {
  for (const file of ['src/firebase.ts', 'firebase-applet-config.json', 'firebase-blueprint.json', 'firestore.rules', 'src/lib/firestoreErrors.ts', 'src/lib/firestoreUtils.ts', 'scripts/import-firebase-users.ts', 'src/utils/accessCodes.ts']) {
    assert.equal(existsSync(new URL('../' + file, import.meta.url)), false, 'Obsolete file: ' + file);
  }
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies.firebase, undefined);
  assert.equal(lock.packages[''].dependencies.firebase, undefined);
  assert.equal(Object.keys(lock.packages).some(name => name === 'node_modules/firebase' || name.startsWith('node_modules/@firebase/')), false);
  for (const folder of ['src', 'server']) {
    for (const filename of sourceFiles(path.join(new URL(root).pathname, folder))) {
      const source = readFileSync(filename, 'utf8');
      assert.doesNotMatch(source, /(?:from\s*['"][^'"]*firebase|import\s*\(['"][^'"]*firebase|require\(['"][^'"]*firebase)/i, 'Unexpected import in ' + filename);
    }
  }
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.doesNotMatch(dockerfile, /firebase|firestore/i);
});
