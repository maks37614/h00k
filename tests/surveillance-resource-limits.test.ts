import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canSaveSurveillance, canActivateSurveillance, MAX_SURVEILLANCE_ACTIVE,
  MAX_SURVEILLANCE_SAVED, UserWorkThrottle } from '../server/surveillanceLimits';

test('24/7 workers are capped per account without pausing grandfathered active coins',()=>{
  const active = Array.from({length:MAX_SURVEILLANCE_ACTIVE},(_,i)=>({id:'coin'+i,isActive:true}));
  assert.equal(canActivateSurveillance(active),false);
  assert.equal(canActivateSurveillance(active,active[0].id),true);
  assert.equal(canActivateSurveillance([...active,{id:'inactive',isActive:false}],'inactive'),false);
  assert.equal(canActivateSurveillance(active.slice(1)),true);
  assert.equal(canSaveSurveillance(Array(MAX_SURVEILLANCE_SAVED).fill({})),false);
  assert.equal(canSaveSurveillance(Array(MAX_SURVEILLANCE_SAVED-1).fill({})),true);
});

test('expensive action throttles are per user and per action, not global',()=>{
  const guard=new UserWorkThrottle();
  assert.equal(guard.allow('alice','check-all',60_000,100_000),true);
  assert.equal(guard.allow('alice','check-all',60_000,110_000),false);
  assert.equal(guard.allow('bob','check-all',60_000,110_000),true);
  assert.equal(guard.allow('alice','check:BTC',20_000,110_000),true);
  assert.equal(guard.allow('alice','check-all',60_000,160_000),true);
  assert.equal(guard.allow('guest','backtest',30_000,160_000),false);
});

test('server enforces limits at all activation and manual analysis entry points',()=>{
  const server=readFileSync(new URL('../server.ts',import.meta.url),'utf8');
  assert.match(server,/canSaveSurveillance\(list\)/);
  assert.match(server,/canActivateSurveillance\(list, existing\.id\)/);
  assert.match(server,/canActivateSurveillance\(found\.list, coin\.id\)/);
  assert.match(server,/loadSurveillanceList\(uid\)\.length > MAX_SURVEILLANCE_ACTIVE/);
  assert.match(server,/userWorkThrottle\.allow\(uid, 'check-all', 60000\)/);
  assert.match(server,/userWorkThrottle\.allow\(found\.userId, 'check:' \+ id, 20000\)/);
  assert.match(server,/userWorkThrottle\.allow\(owner, 'backtest', 30000\)/);
});
