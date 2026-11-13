'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dockRects, floatingRects } = require('../layout.cjs');
const { normalizeSettings, matchesTerminal, availablePanels } = require('../profiles.cjs');

test('one independent workspace per provider and safe persisted values', () => {
  const settings = normalizeSettings({ profiles: {
    metascalp: { mode: 'floating', side: 'top', widgets: ['early', 'early', 'nonsense'], width: 100000 },
    tiger: { enabled: true, mode: 'blocks', side: 'bottom', widgets: ['terminal'] },
  } });
  assert.equal(settings.profiles.metascalp.mode, 'floating');
  assert.deepEqual(availablePanels(settings.profiles.metascalp), ['early']);
  assert.equal(settings.profiles.metascalp.width, 1100);
  assert.equal(settings.profiles.tiger.side, 'bottom');
  assert.deepEqual(availablePanels(settings.profiles.tiger), ['terminal']);
  assert.equal(settings.profiles.vataga.enabled, false);
  assert.deepEqual(availablePanels(normalizeSettings().profiles.metascalp), ['full']);
});
test('automatic matching requires terminal executable, never title alone', () => {
  assert.equal(matchesTerminal('metascalp', {exe:'MetaScalp', title:'OK'}), true);
  assert.equal(matchesTerminal('tiger', {exe:'Tiger.Trade', title:'Trader'}), true);
  assert.equal(matchesTerminal('vataga', {exe:'Vataga.terminal', title:'Trader'}), true);
  assert.equal(matchesTerminal('vataga', {exe:'chrome', title:'Vataga'}), false);
  assert.equal(matchesTerminal('tiger', {exe:'hook', title:'Tiger.Trade'}), false);
});
test('docking in all four directions keeps terminal rectangle untouched', () => {
  const target = {x:400,y:250,width:700,height:500};
  const work = {x:0,y:0,width:1920,height:1080};
  const cases = {right:{x:1106},left:{x:64},top:{y:44},bottom:{y:756}};
  for (const side of Object.keys(cases)) {
    const boxes = dockRects(target,work,side,330,200,1);
    assert.equal(boxes.length,1,side);
    assert.equal(boxes[0][Object.keys(cases[side])[0]],Object.values(cases[side])[0]);
  }
});
test('multiple widgets stack in strip without overlapping', () => {
  const boxes = dockRects({x:100,y:100,width:800,height:700},{x:0,y:0,width:1800,height:1000},'right',300,220,3);
  assert.equal(boxes.length,3);
  for(let i=1;i<boxes.length;i++) assert.ok(boxes[i].y >= boxes[i-1].y + boxes[i-1].height);
});
test('never overlap trading terminal if monitor has no room', () => {
  assert.deepEqual(dockRects({x:0,y:0,width:1920,height:1000},{x:0,y:0,width:1920,height:1080},'right',440,360,1),[]);
  assert.deepEqual(dockRects({x:0,y:0,width:1920,height:1000},{x:0,y:0,width:1920,height:1080},'bottom',440,360,1),[]);
});
test('negative coordinates and floating bounds are valid for secondary monitors', () => {
  const work = {x:-1920,y:0,width:1920,height:1080};
  const target = {x:-1600,y:160,width:1000,height:700};
  assert.equal(dockRects(target,work,'left',300,300,1).length,1);
  for(const bounds of floatingRects(target,work,500,300,4)) {
    assert.ok(bounds.x >= work.x && bounds.x+bounds.width <= work.x+work.width);
  }
});
