import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartTouchHold, isChartControlTarget } from '../src/components/hookchart/touchHold';

function clock() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const cancelled: number[] = [];
  return {
    schedule(callback: () => void, delay: number) {
      assert.equal(delay, 350);
      callbacks.set(++nextId, callback);
      return nextId;
    },
    cancel(handle: unknown) {
      cancelled.push(Number(handle));
      callbacks.delete(Number(handle));
    },
    fire() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach(callback => callback());
    },
    get count() { return callbacks.size; },
    callbacks, cancelled,
  };
}

test('a hold activates at chart corners, price-scale coordinates and the volume area', () => {
  for (const point of [{x:1,y:1}, {x:389,y:1}, {x:389,y:699}, {x:1,y:699}, {x:365,y:250}, {x:200,y:650}]) {
    const time = clock(), hold = createChartTouchHold(time);
    let selected: {x:number;y:number} | null = null;
    hold.start(1, point, position => { selected = position; });
    assert.equal(hold.pending(), true);
    time.fire();
    assert.deepEqual(selected, point);
    assert.equal(hold.pending(), false);
    assert.equal(time.count, 0);
  }
});

test('small finger tremor still activates at the latest position without starting a drag', () => {
  const time = clock(), hold = createChartTouchHold(time);
  let selected: {x:number;y:number} | null = null;
  hold.start(1, {x:100,y:200}, position => { selected = position; });
  assert.equal(hold.move(1, {x:106,y:205}), true);
  assert.equal(hold.move(1, {x:108,y:206}), true);
  time.fire();
  assert.deepEqual(selected, {x:108,y:206});
});

test('a deliberate swipe cancels inspection so panning/scaling can proceed', () => {
  const time = clock(), hold = createChartTouchHold(time);
  let activations = 0;
  hold.start(1, {x:100,y:200}, () => { activations++; });
  assert.equal(hold.move(1, {x:111,y:200}), false);
  assert.equal(hold.pending(), false);
  time.fire();
  assert.equal(activations, 0);
});

test('lifting, cancellation, or a second finger cannot leave a delayed activation behind', () => {
  const time = clock(), hold = createChartTouchHold(time);
  let activations = 0;
  hold.start(1, {x:100,y:200}, () => { activations++; });
  const stale = [...time.callbacks.values()][0];
  hold.cancel();
  stale();
  time.fire();
  assert.equal(activations, 0);
  hold.start(2, {x:150,y:250}, () => { activations++; });
  time.fire();
  assert.equal(activations, 1);
  for (let x = 0; x < 100; x++) assert.equal(hold.move(2, {x,y:250}), false);
  assert.equal(activations, 1);
  assert.equal(time.count, 0);
});

test('only the pending pointer controls its hold; replacing a hold cancels the old one', () => {
  const time = clock(), hold = createChartTouchHold(time);
  const selected: number[] = [];
  hold.start(1, {x:100,y:200}, () => selected.push(1));
  assert.equal(hold.move(99, {x:300,y:400}), false);
  assert.equal(hold.pending(), true);
  hold.start(2, {x:110,y:210}, () => selected.push(2));
  time.fire();
  assert.deepEqual(selected, [2]);
});

test('real controls are excluded while passive HUD descendants and the canvas are not', () => {
  // The DOM supplies closest(); this checks that no blanket overlay/chart selector is used.
  const element = (ancestor: string) => ({
    closest(selector: string) {
      return selector.split(',').map(s => s.trim()).includes(ancestor) ? this : null;
    },
  }) as unknown as EventTarget;
  for (const ancestor of ['button','input','select','textarea','a','[role="button"]','.timeJumpDock','.chartScaleDock'])
    assert.equal(isChartControlTarget(element(ancestor)), true);
  for (const ancestor of ['canvas','.liqRiskHud','.liqRiskContent','.chartWrap'])
    assert.equal(isChartControlTarget(element(ancestor)), false);
  assert.equal(isChartControlTarget(null), false);
});
