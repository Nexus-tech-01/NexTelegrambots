import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeTgs } from '../lottie-renderer.mjs';

const lottie={
  v:'5.7.4',
  fr:30,
  ip:0,
  op:90,
  w:512,
  h:512,
  nm:'NexAi TGS test',
  ddd:0,
  assets:[],
  layers:[]
};
const tgs=gzipSync(Buffer.from(JSON.stringify(lottie),'utf8'));
const decoded=decodeTgs(tgs);
assert.equal(decoded.width,512);
assert.equal(decoded.height,512);
assert.equal(decoded.fps,30);
assert.equal(decoded.duration,3);
assert.equal(JSON.parse(decoded.json).nm,'NexAi TGS test');

assert.throws(()=>decodeTgs(Buffer.from('not-gzip')),/gzip attendu/);
assert.throws(()=>decodeTgs(gzipSync(Buffer.from('{bad json'))),/JSON Lottie illisible/);

// Verify that the native Skottie runtime expected by TGS export is actually
// loadable and can render a Telegram-sized Lottie frame.
const { createCanvas, LottieAnimation }=await import('@napi-rs/canvas');
const animation=LottieAnimation.loadFromData(JSON.stringify(lottie),{});
assert.equal(Math.round(animation.fps),30);
assert.equal(Math.round(animation.frames),90);
const canvas=createCanvas(512,512);
const ctx=canvas.getContext('2d');
animation.seekFrame(0);
animation.render(ctx,{x:0,y:0,width:512,height:512});
const png=await canvas.encode('png');
assert.ok(png.length>8);
assert.equal(png[0],0x89);
assert.equal(png.toString('ascii',1,4),'PNG');

console.log('TGS decode regression tests: ok');
