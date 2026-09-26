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

console.log('TGS decode regression tests: ok');
