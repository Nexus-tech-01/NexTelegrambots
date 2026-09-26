import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fingerprint,readJson,rememberIncident,writeJsonAtomic} from './supervision-core.mjs';

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'nex-supervision-test-'));
const stateFile=path.join(tmp,'state.json');
await writeJsonAtomic(stateFile,{ok:true,nested:{value:2}});
assert.deepEqual(await readJson(stateFile,{}),{ok:true,nested:{value:2}});

const a=fingerprint('health','nexaccount','HTTP 503 after 12000ms');
const b=fingerprint('health','nexaccount','HTTP 503 after 45000ms');
assert.equal(a,b,'numeric-only changes should collapse to one incident fingerprint');

const state={incidents:{},incidentOrder:[],learnedRules:{}};
for(let i=0;i<3;i++)rememberIncident(state,{kind:'health',target:'nexaccount',message:'connection refused 127.0.0.1:3491'});
assert.equal(Object.keys(state.incidents).length,1);
assert.equal(Object.keys(state.learnedRules).length,1,'recurring incidents should promote an adaptive rule');

console.log('Nexus supervision regression tests: OK');
