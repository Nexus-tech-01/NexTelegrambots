import { accountAssignedToWorker, runtimeBucketFor } from '../store.mjs';

const counts=[1,2,3,4,8,16,32,64,128,256];
const ids=[
  '1','2','123456789','9876543210','1000000000001','188900000001',
  ...Array.from({length:5000},(_,i)=>String(100000000+i*7919))
];

for(const count of counts){
  const distribution=Array(count).fill(0);
  for(const id of ids){
    const owners=[];
    for(let index=0;index<count;index++){
      if(accountAssignedToWorker(id,index,count))owners.push(index);
    }
    if(owners.length!==1)throw new Error(`account ${id} has ${owners.length} owners for workerCount=${count}`);
    distribution[owners[0]]++;
    const bucket=runtimeBucketFor(id);
    if(!Number.isInteger(bucket)||bucket<0||bucket>=65536)throw new Error('invalid runtime bucket');
  }
  if(count>1&&distribution.some(n=>n===0))throw new Error(`empty shard detected for workerCount=${count}`);
}

console.log('NexAccount sharding OK ·',ids.length,'accounts tested');
