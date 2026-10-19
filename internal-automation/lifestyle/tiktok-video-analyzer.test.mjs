import test from 'node:test';
import assert from 'node:assert/strict';
import {visionProviderStatus} from './tiktok-video-analyzer.mjs';

test('OpenRouter prefers free vision router even when old paid model is configured',()=>{
 const prevKey=process.env.OPENROUTER_API_KEY;
 const prevModel=process.env.NEXAI_OPENROUTER_MODEL;
 try{
  process.env.OPENROUTER_API_KEY='placeholder-test-key';
  process.env.NEXAI_OPENROUTER_MODEL='openai/gpt-4o-mini';
  const list=visionProviderStatus().filter(x=>x.name.startsWith('openrouter'));
  assert.deepEqual(list.map(x=>x.model),['openrouter/free','openai/gpt-4o-mini']);
 }finally{
  if(prevKey===undefined)delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY=prevKey;
  if(prevModel===undefined)delete process.env.NEXAI_OPENROUTER_MODEL;
  else process.env.NEXAI_OPENROUTER_MODEL=prevModel;
 }
});
