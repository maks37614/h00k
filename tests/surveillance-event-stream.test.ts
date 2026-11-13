import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publishSurveillance, subscribeSurveillance, surveillanceStreamStats } from '../server/surveillanceEvents';

test('SSE invalidations are isolated per user and 15-second coalesced', () => {
  const a:number[] = [], b:number[] = [];
  const clearA = subscribeSurveillance('user-a', version=>a.push(version));
  const clearB = subscribeSurveillance('user-b', version=>b.push(version));
  assert.ok(clearA && clearB);
  publishSurveillance('user-a', false, 100_000);
  publishSurveillance('user-a', false, 100_010);
  publishSurveillance('user-b', false, 100_010);
  assert.deepEqual(a,[1]);
  assert.deepEqual(b,[1]);
  publishSurveillance('user-a', false, 115_100);
  assert.deepEqual(a,[1,2]);
  clearA?.();clearB?.();
  assert.equal(surveillanceStreamStats().clients,0);
});

test('SSE enforces per-user connection limits and cleans up listeners',()=>{
  const handles = Array.from({length:3},()=>subscribeSurveillance('test-user',()=>{}));
  assert.ok(handles.every(Boolean));
  assert.equal(subscribeSurveillance('test-user',()=>{}),null);
  handles.forEach(fn=>fn?.());
  assert.equal(surveillanceStreamStats().clients,0);
});

test('server route authenticates via bearer token, sends only invalidations and bounds backpressure',()=>{
  const server=readFileSync(new URL('../server.ts',import.meta.url),'utf8');
  const client=readFileSync(new URL('../src/context/SurveillanceContext.tsx',import.meta.url),'utf8');
  const worker=readFileSync(new URL('../server/surveillance/coinWorker.ts',import.meta.url),'utf8');
  assert.match(server,/app\.use\(\['\/api\/alerts',[^\n]*'\/api\/surveillance'/);
  assert.match(server,/app\.get\('\/api\/surveillance\/stream'/);
  assert.match(server,/res\.locals\.userId/);
  assert.match(server,/X-Accel-Buffering/);
  assert.match(server,/!res\.write/);
  assert.doesNotMatch(server,/\?token=|req\.query\.token/);
  assert.match(client,/apiFetch\('\/api\/surveillance\/stream'/);
  assert.match(client,/}, 60000\);/);
  assert.match(client,/controller\?\.abort\(\)/);
  assert.match(worker,/publishSurveillance\(this\.coin\.userId\)/);
});
