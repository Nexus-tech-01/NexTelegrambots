import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,dashboardCount,totalCount} from '../src/catalog.mjs';

test('catalog paths are unique',()=>{
  assert.equal(new Set(catalog.map(x=>x.path)).size,catalog.length);
});
test('dashboard compatibility set has 59 routes',()=>assert.equal(dashboardCount,59));
test('legacy/hidden routes are preserved too',()=>assert.equal(totalCount,70));
test('sensitive routes are disabled',()=>{
  for(const path of ['/nsfw','/deepfake'])assert.equal(catalog.find(x=>x.path===path)?.mode,'disabled');
});
