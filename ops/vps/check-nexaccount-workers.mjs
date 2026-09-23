const requested=Number(process.argv[2]||process.env.NEXACCOUNT_WORKER_COUNT||1);
if(!Number.isInteger(requested)||requested<1||requested>256){
  throw new Error('worker count must be an integer between 1 and 256');
}

const basePort=Number(process.env.NEXACCOUNT_BASE_PORT||3491);
const failures=[];
const rows=[];

for(let index=0;index<requested;index++){
  const port=basePort+index;
  try{
    const response=await fetch('http://127.0.0.1:'+port+'/health',{
      signal:AbortSignal.timeout(3000)
    });
    const text=await response.text();
    let data={};
    try{data=JSON.parse(text)}catch{}
    const worker=data?.worker||{};
    const ok=response.ok
      && data?.ok===true
      && data?.service==='nexaccount'
      && Number(worker.index)===index
      && Number(worker.count)===requested;
    rows.push({
      index,
      port,
      httpStatus:response.status,
      reportedIndex:worker.index,
      reportedCount:worker.count,
      runtimeCount:data?.runtimeCount,
      coordinator:index===0
    });
    if(!ok)failures.push('worker '+index+' returned inconsistent health data');
  }catch(error){
    rows.push({index,port,error:String(error?.message||error)});
    failures.push('worker '+index+' is unreachable on port '+port);
  }
}

console.log(JSON.stringify({ok:failures.length===0,workers:rows,failures},null,2));
if(failures.length)process.exit(1);
