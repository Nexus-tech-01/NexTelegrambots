import fs from 'node:fs/promises';
import { build } from 'esbuild';

await fs.mkdir('public',{recursive:true});
await Promise.all([
  fs.copyFile('index.html','public/index.html'),
  fs.copyFile('style.css','public/style.css')
]);
await build({
  entryPoints:['app.js'],
  bundle:true,
  minify:true,
  platform:'browser',
  format:'iife',
  target:['es2020'],
  outfile:'public/app.js'
});
console.log('NexAI Connect build complete');
