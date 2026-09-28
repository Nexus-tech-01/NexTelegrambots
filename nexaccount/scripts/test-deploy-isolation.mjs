import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const workflowPath=path.resolve(here,'../../.github/workflows/deploy-nexaccount.yml');
const source=await fs.readFile(workflowPath,'utf8');
const failures=[];

const triggerBlock=source.slice(source.indexOf('on:\n'),source.indexOf('\npermissions:'));
if(!/workflow_dispatch:\s*/.test(triggerBlock))failures.push('deploy workflow must stay manual-only');
if(/\n\s*push:\s*/.test(triggerBlock))failures.push('push trigger must never restart NexAccount/NexAnime');
if(/\n\s*pull_request:\s*/.test(triggerBlock))failures.push('pull_request trigger must never deploy NexAccount/NexAnime');
if(!triggerBlock.includes('confirm_nexanime_restart:'))failures.push('manual NexAnime restart confirmation input is missing');
if(!source.includes('if: ${{ inputs.confirm_nexanime_restart == true }}'))failures.push('deploy job must require explicit NexAnime restart confirmation');
if(!source.includes('NEXANIME_RUNTIME_CONTRACT_OK'))failures.push('post-deploy NexAnime health contract is missing');
if(!source.includes('ROLLBACK_KEPT_HEALTHY_RUNTIME'))failures.push('healthy-runtime rollback protection is missing');

if(failures.length){
  console.error('DEPLOY_ISOLATION_REGRESSION\n'+failures.join('\n'));
  process.exit(1);
}
console.log('DEPLOY_ISOLATION_OK manual-only + explicit restart confirmation + health/rollback guards');
