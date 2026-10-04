import assert from 'node:assert/strict';
import {commandMap} from '../commands.mjs';
import {parseCommand} from '../core/command-parser.mjs';

const commands=commandMap();
const purge=commands.get('purge');
assert.ok(purge,'purge must be registered');
assert.equal(purge.hidden===true,false,'purge must be visible for prefixless parsing');
assert.equal(purge.handler,'clean','purge must route to clean');
assert.equal(purge.groupOnly,true,'purge must remain group-only');
assert.equal(purge.adminOnly,true,'purge must remain admin-only');

const isKnown=name=>{
  const cmd=commands.get(String(name||'').toLowerCase());
  return Boolean(cmd&&cmd.hidden!==true);
};

const bare=parseCommand('purge 250','.',{allowBare:true,isKnownCommand:isKnown});
assert.deepEqual(bare,{name:'purge',args:['250'],kind:'bare'});

const prefixed=parseCommand('.purge 500','.',{allowBare:false,isKnownCommand:isKnown});
assert.deepEqual(prefixed,{name:'purge',args:['500'],kind:'prefix'});

console.log(JSON.stringify({ok:true,bare,prefixed,handler:purge.handler}));
