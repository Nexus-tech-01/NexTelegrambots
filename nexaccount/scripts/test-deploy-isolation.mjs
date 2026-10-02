import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const workflowPath=path.resolve(here,'../../.github/workflows/deploy-nexaccount.yml');
const source=await fs.readFile(workflowPath,'utf8');
const promoteSource=await fs.readFile(path.resolve(here,'promote-systemd-release.mjs'),'utf8');
const failures=[];

const triggerBlock=source.slice(source.indexOf('on:\n'),source.indexOf('\npermissions:'));
if(!/workflow_dispatch:\s*/.test(triggerBlock))failures.push('deploy workflow must stay manual-only');
if(/\n\s*push:\s*/.test(triggerBlock))failures.push('push trigger must never restart NexAccount/NexAnime');
if(/\n\s*pull_request:\s*/.test(triggerBlock))failures.push('pull_request trigger must never deploy NexAccount/NexAnime');
if(!triggerBlock.includes('confirm_nexanime_restart:'))failures.push('manual NexAnime restart confirmation input is missing');
if(!source.includes('if: ${{ inputs.confirm_nexanime_restart == true }}'))failures.push('deploy job must require explicit NexAnime restart confirmation');
if(!source.includes('NEXANIME_RUNTIME_CONTRACT_OK'))failures.push('post-deploy NexAnime health contract is missing');
if(!source.includes('promote-systemd-release.mjs'))failures.push('canonical systemd release promotion is missing');
if(source.includes('bootstrap.mjs'))failures.push('deploy workflow must not start an auxiliary NexAccount bootstrap runtime');
if(!source.includes('PRODUCTION_ROLLBACK_OK'))failures.push('canonical production rollback protection is missing');
if(!promoteSource.includes("run('chgrp',['-R',String(process.env.NEXACCOUNT_SYSTEMD_GROUP||'nex'),destination],30000)"))failures.push('promoted release must be assigned to the NexAccount systemd group');
if(!promoteSource.includes("run('chmod',['-R','g+rX',destination],30000)"))failures.push('promoted release must be group-readable/traversable before systemd switch');

if(failures.length){
  console.error('DEPLOY_ISOLATION_REGRESSION\n'+failures.join('\n'));
  process.exit(1);
}
console.log('DEPLOY_ISOLATION_OK manual-only + canonical systemd promotion + explicit health/rollback guards');