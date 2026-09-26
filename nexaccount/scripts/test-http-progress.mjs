import assert from 'node:assert/strict';
import { responseBuffer } from '../dipper-fallback.mjs';

const body=Buffer.from('abcdefghij');
const progress=[];
const res=new Response(body,{
  headers:{
    'content-length':String(body.length),
    'content-type':'application/octet-stream'
  }
});
const out=await responseBuffer(res,1024,p=>progress.push(p));
assert.equal(out.toString(),'abcdefghij');
assert.equal(progress.at(-1),100,'streamed HTTP download must finish at 100%');
assert.ok(progress.some(p=>p>0),'streamed HTTP download must emit visible progress');

const oversized=new Response(Buffer.alloc(20),{
  headers:{'content-length':'20'}
});
await assert.rejects(()=>responseBuffer(oversized,10),/trop volumineux/);

console.log('HTTP progress regression tests: ok');
