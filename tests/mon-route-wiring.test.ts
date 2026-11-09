import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('h00k server mounts the protected Krystian feed before SPA fallback', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const monImport = server.indexOf("import { installMonMarketFeed } from './server/monMarketFeed'");
  const monMount = server.indexOf('installMonMarketFeed(app);');
  const fallback = server.indexOf("app.get('*',");
  assert.ok(monImport >= 0, 'Mon feed module must be imported into the live server');
  assert.ok(monMount >= 0, 'Mon API must actually be mounted in the live server');
  assert.ok(fallback > monMount, 'Protected API must be installed before SPA wildcard');
  assert.match(server, /formationDensityFeed\.start\(\);/, 'Real synchronized depth collector must start');
});
