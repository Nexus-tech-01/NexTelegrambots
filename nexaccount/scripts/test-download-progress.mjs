import assert from 'node:assert/strict';
import { parseYtDlpProgressLine } from '../dipper-fallback.mjs';

const cases=[
  ['NEXAI_PROGRESS:0.0%',0],
  ['NEXAI_PROGRESS:4.7%',5],
  ['NEXAI_PROGRESS:42.2%',42],
  ['[download] NEXAI_PROGRESS:99.6%',100],
  ['NEXAI_PROGRESS:100.0%',100],
  ['NEXAI_PROGRESS:140.5%',100],
  ['NEXAI_PROGRESS:-2%',null],
  ['[download] 42.0% of 5MiB',null],
  ['',null]
];

for(const [line,expected] of cases){
  assert.equal(parseYtDlpProgressLine(line),expected,line);
}

console.log('yt-dlp progress parser regression tests: ok');
