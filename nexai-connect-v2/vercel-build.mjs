import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

async function firstExisting(paths){
  for (const p of paths){
    try { await access(p); return p; } catch {}
  }
  throw new Error('NexAI Connect V2 asset not found');
}

const source=await firstExisting([
  'assets/index.html.gz',
  'nexai-connect-v2/assets/index.html.gz'
]);
await mkdir('public',{recursive:true});
const html=gunzipSync(await readFile(source));
await writeFile('public/index.html',html);
console.log('NexAI Connect V2 production bundle:',source,html.length,'bytes');
