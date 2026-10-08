// Read-only smoke checks. Do not send real bot credentials or OTPs here.
const root = String(process.env.RESCUE_BASE_URL || "http://127.0.0.1:8082").replace(/[/]$/,"");
const cases = [
  ["/health/live",200],
  ["/health/ready",200],
  ["/login",200],
  ["/server",303],
];
let failures=0;
for (const [pathname,expected] of cases) {
  try {
    const r=await fetch(root+pathname,{redirect:"manual",signal:AbortSignal.timeout(5000)});
    const ok=r.status===expected;
    console.log((ok?"PASS":"FAIL"),pathname,"HTTP",r.status,"expected",expected);
    if(!ok)failures++;
  }catch(err){failures++;console.log("FAIL",pathname,String(err?.name||"unavailable"))}
}
for (const pathname of ["/api/admin/agent/jobs","/api/v1/agent/jobs/claim"]) {
  try {
    const r=await fetch(root+pathname,{method:"POST",headers:{"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(5000)});
    const ok=r.status===401;
    console.log((ok?"PASS":"FAIL"),"unauthenticated",pathname,"HTTP",r.status);
    if(!ok)failures++;
  }catch(err){failures++;console.log("FAIL",pathname,String(err?.name||"unavailable"))}
}
process.exitCode=failures?1:0;
