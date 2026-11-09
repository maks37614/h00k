import test from 'node:test';
import assert from 'node:assert/strict';
import { touchMagnifierLayout, drawTouchMagnifier } from '../src/components/hookchart/touchMagnifier';

test('touch magnifier stays centred on the crosshair on phone, tablet and desktop, including edges', () => {
  for (const [width, height] of [[240, 160], [390, 700], [768, 500], [1366, 800]]) {
    for (const point of [{x:0,y:0}, {x:width,y:height}, {x:width/2,y:height/2}, {x:-30,y:height+40}]) {
      const lens = touchMagnifierLayout(width, height, point)!;
      assert.equal(lens.x, Math.max(0, Math.min(width, point.x)));
      assert.equal(lens.y, Math.max(0, Math.min(height, point.y)));
      assert.ok(lens.radius > 0 && lens.radius <= 58);
      assert.equal(lens.sourceX + lens.sourceSize / 2, Math.max(0, Math.min(width, point.x)));
      assert.equal(lens.sourceY + lens.sourceSize / 2, Math.max(0, Math.min(height, point.y)));
      assert.equal(lens.size / lens.sourceSize, 2);
    }
  }
});

test('lens has no vertical offset at the intersection, even near the top; invalid/tiny charts are skipped', () => {
  const point = {x:180,y:400};
  const lens = touchMagnifierLayout(390, 700, point)!;
  assert.equal(lens.x, point.x);
  assert.equal(lens.y, point.y);
  const nearTop = touchMagnifierLayout(390, 700, {x:180,y:10})!;
  assert.equal(nearTop.y, 10);
  assert.equal(touchMagnifierLayout(40, 40, point), null);
  assert.equal(touchMagnifierLayout(390, 700, {x:NaN,y:10}), null);
});

test('retina magnifier samples before drawing its overlay, with no recursive screenshot', () => {
  const calls: {kind:string;args:unknown[]}[] = [];
  const sampleContext = {
    clearRect(){},
    drawImage(...args:unknown[]){calls.push({kind:'sample',args});},
  };
  const chart = {width:780,height:1400} as HTMLCanvasElement;
  const sample = {width:0,height:0,getContext:()=>sampleContext} as unknown as HTMLCanvasElement;
  const context = {
    save(){},restore(){},setLineDash(){},beginPath(){},arc(){},fill(){calls.push({kind:'fill',args:[]});},
    clip(){},stroke(){},
    drawImage(...args:unknown[]){calls.push({kind:'lens',args});},
  } as unknown as CanvasRenderingContext2D;
  drawTouchMagnifier(chart, context, sample, 390, 700, {x:180,y:400});
  assert.deepEqual(calls.map(c=>c.kind), ['sample','fill','lens']);
  assert.equal(calls[0].args[0], chart);
  assert.equal(calls[2].args[0], sample);
  assert.equal(sample.width, 232);
  assert.equal(sample.height, 232);
  assert.equal(calls[0].args[3], 116);
  assert.equal(calls[0].args[4], 116);
});

test('4x phone screens keep a bounded scratch bitmap for the 2x lens', () => {
  const sampleContext = { clearRect(){}, drawImage(){} };
  const chart = {width:1560,height:2800} as HTMLCanvasElement;
  const sample = {width:0,height:0,getContext:()=>sampleContext} as unknown as HTMLCanvasElement;
  const context = {
    save(){},restore(){},setLineDash(){},beginPath(){},arc(){},fill(){},clip(){},stroke(){},drawImage(){},
  } as unknown as CanvasRenderingContext2D;
  drawTouchMagnifier(chart, context, sample, 390, 700, {x:180,y:400});
  assert.equal(sample.width, 232);
  assert.equal(sample.height, 232);
});

test('every sampled region keeps the touched pixel centred, including retina chart corners', () => {
  for (const dpr of [1,2,3,4]) {
    for (const point of [{x:0,y:0}, {x:389,y:0}, {x:389,y:699}, {x:0,y:699}, {x:15,y:350}, {x:370,y:250}, {x:180,y:650}]) {
      let copy: number[] = [];
      const sampleContext = { clearRect(){}, drawImage(_chart: unknown, ...args: number[]) { copy = args; } };
      const chart = {width:390*dpr,height:700*dpr} as HTMLCanvasElement;
      const sample = {width:0,height:0,getContext:()=>sampleContext} as unknown as HTMLCanvasElement;
      const context = {
        save(){},restore(){},setLineDash(){},beginPath(){},arc(){},fill(){},clip(){},stroke(){},drawImage(){},
      } as unknown as CanvasRenderingContext2D;
      drawTouchMagnifier(chart, context, sample, 390, 700, point);
      const [sx,sy,sw,sh,dx,dy,dw,dh] = copy;
      assert.ok(sx >= 0 && sy >= 0 && sw > 0 && sh > 0);
      assert.ok(sx+sw <= chart.width + 1e-8 && sy+sh <= chart.height + 1e-8);
      const selectedX=dx+(point.x*dpr-sx)/sw*dw;
      const selectedY=dy+(point.y*dpr-sy)/sh*dh;
      assert.ok(Math.abs(selectedX-sample.width/2)<1e-8, JSON.stringify({dpr,point,copy,selectedX}));
      assert.ok(Math.abs(selectedY-sample.height/2)<1e-8, JSON.stringify({dpr,point,copy,selectedY}));
    }
  }
});

test('the isolated lens composites its cursor in source coordinates at every chart edge', () => {
  for (const point of [{x:0,y:0},{x:389,y:0},{x:0,y:699},{x:389,y:699},{x:180,y:400}]) {
    const calls: string[] = [], transforms: number[][] = [];
    const sampleContext = {
      clearRect(){},drawImage(){calls.push('scene');},save(){},restore(){},
      setTransform(...matrix:number[]){transforms.push(matrix);},
    } as unknown as CanvasRenderingContext2D;
    const chart={width:1170,height:2100} as HTMLCanvasElement;
    const sample={width:0,height:0,getContext:()=>sampleContext} as unknown as HTMLCanvasElement;
    const context={save(){},restore(){},setLineDash(){},beginPath(){},arc(){},fill(){},clip(){},stroke(){},drawImage(){calls.push('lens');}} as unknown as CanvasRenderingContext2D;
    drawTouchMagnifier(chart,context,sample,390,700,point,'#131722',target=>{
      assert.equal(target,sampleContext);
      calls.push('cursor');
    });
    assert.deepEqual(calls,['scene','cursor','lens']);
    const [a,, ,d,tx,ty]=transforms[0];
    assert.ok(Math.abs(point.x*a+tx-sample.width/2)<1e-8);
    assert.ok(Math.abs(point.y*d+ty-sample.height/2)<1e-8);
  }
});
