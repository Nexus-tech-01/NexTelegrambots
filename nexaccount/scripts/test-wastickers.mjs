import assert from 'node:assert/strict';
import { buildWastickersArchive } from '../sticker-engine.mjs';

function fakeWebp(size=32){
  const b=Buffer.alloc(Math.max(12,size));
  b.write('RIFF',0,'ascii');
  b.writeUInt32LE(Math.max(4,b.length-8),4);
  b.write('WEBP',8,'ascii');
  return b;
}
function fakePng(size=32){
  const b=Buffer.alloc(Math.max(8,size));
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b,0);
  return b;
}

const pack=buildWastickersArchive({
  title:'NexAi Test',
  author:'@session_user',
  cover:fakePng(),
  stickers:[
    {buffer:fakeWebp(),animated:false},
    {buffer:fakeWebp(),animated:false},
    {buffer:fakeWebp(),animated:true}
  ]
});
assert.equal(pack.readUInt32LE(0),0x04034b50,'archive must start with a ZIP local header');
const text=pack.toString('latin1');
for(const name of ['title.txt','author.txt','cover.png','sticker_01.webp','sticker_02.webp','sticker_03.webp']){
  assert.ok(text.includes(name),'missing '+name);
}

assert.throws(()=>buildWastickersArchive({
  cover:fakePng(),
  stickers:[{buffer:fakeWebp()},{buffer:fakeWebp()}]
}),/3 à 30/);

assert.throws(()=>buildWastickersArchive({
  cover:Buffer.from('not-png'),
  stickers:[{buffer:fakeWebp()},{buffer:fakeWebp()},{buffer:fakeWebp()}]
}),/PNG valide/);

assert.throws(()=>buildWastickersArchive({
  cover:fakePng(),
  stickers:[{buffer:Buffer.from('bad')},{buffer:fakeWebp()},{buffer:fakeWebp()}]
}),/WebP valide/);

console.log('wastickers regression tests: ok');
