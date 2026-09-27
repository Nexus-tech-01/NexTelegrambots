import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
await mkdir('public',{recursive:true});
const html=gunzipSync(await readFile('assets/index.html.gz'));
await writeFile('public/index.html',html);
console.log('NexAI Connect V2 built:',html.length,'bytes');
