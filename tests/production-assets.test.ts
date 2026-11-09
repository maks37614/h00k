import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { installProductionAssets } from '../server/productionAssets';

test('production serves real bundles, returns 404 for missing assets, and preserves SPA routes', async t => {
  const directory = await mkdtemp(path.join(process.cwd(), 'tests', 'assets-fixture-'));
  await mkdir(path.join(directory, 'assets'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>H00K fixture</title>');
  await writeFile(path.join(directory, 'assets', 'index-current.js'), 'export const version = 1;');
  await writeFile(path.join(directory, 'assets', 'index-current.css'), 'body { color: white; }');
  const app = express();
  installProductionAssets(app, directory);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const extension of ['js', 'css']) {
    const present = await fetch(`${base}/assets/index-current.${extension}`);
    assert.equal(present.status, 200);
    assert.match(present.headers.get('content-type')!, extension === 'js' ? /javascript/ : /text\/css/);
    assert.match(present.headers.get('cache-control')!, /immutable/);
    const missing = await fetch(`${base}/assets/index-old.${extension}`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /<!doctype|H00K fixture/i);
  }
  for (const route of ['/', '/terms', '/privacy', '/replay']) {
    const page = await fetch(base + route);
    assert.equal(page.status, 200, route);
    assert.match(await page.text(), /H00K fixture/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
  }
});
