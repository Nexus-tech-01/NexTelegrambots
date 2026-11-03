'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ssh = require('../api/ssh.js');

function invoke(method='POST',headers={},body={}) {
  return new Promise(resolve => {
    const res={statusCode:200,headers:{},
      setHeader(key,value){this.headers[key.toLowerCase()]=value;},
      end(value){resolve({status:this.statusCode,body:JSON.parse(value),headers:this.headers});}
    };
    Promise.resolve(ssh({method,headers,body},res)).catch(e=>resolve({error:String(e)}));
  });
}
const envKeys=['NXC_SSH_ADMIN_TOKEN','NXC_SSH_ALLOWED_HOSTS','NXC_SSH_PORT'];
const previous=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
test.after(()=>{for(const k of envKeys){if(previous[k]===undefined) delete process.env[k];else process.env[k]=previous[k];}});
const token='z'.repeat(64);
test('disabled until explicitly configured',async()=>{
  delete process.env.NXC_SSH_ADMIN_TOKEN;
  delete process.env.NXC_SSH_ALLOWED_HOSTS;
  assert.equal((await invoke()).status,503);
});
test('unknown access token rejected without network access',async()=>{
  process.env.NXC_SSH_ADMIN_TOKEN=token;
  process.env.NXC_SSH_ALLOWED_HOSTS='31.56.85.53';
  assert.equal((await invoke('POST',{'x-nxc-ssh-token':'wrong'},{host:'31.56.85.53',mode:'fingerprint'})).status,401);
});
test('cannot connect to non-allowlisted or local IPv4',async()=>{
  process.env.NXC_SSH_ADMIN_TOKEN=token;
  process.env.NXC_SSH_ALLOWED_HOSTS='31.56.85.53';
  for(const host of ['127.0.0.1','169.254.169.254','10.0.0.1','localhost','example.com']) {
    const result=await invoke('POST',{'x-nxc-ssh-token':token},{host,mode:'fingerprint'});
    assert.equal(result.status,403);
  }
});
test('rejects bad origins, invalid operations and missing fingerprint before dialing',async()=>{
  process.env.NXC_SSH_ADMIN_TOKEN=token;
  process.env.NXC_SSH_ALLOWED_HOSTS='31.56.85.53';
  const h={'x-nxc-ssh-token':token};
  assert.equal((await invoke('POST',{...h,origin:'https://evil.example',host:'nexcontrol-nexus-vps.vercel.app'},{host:'31.56.85.53',mode:'fingerprint'})).status,403);
  assert.equal((await invoke('POST',h,{host:'31.56.85.53',mode:'delete'})).status,400);
  assert.equal((await invoke('POST',h,{host:'31.56.85.53',mode:'exec',username:'root',password:'test',command:'id'})).status,400);
  assert.equal((await invoke('GET',h,{host:'31.56.85.53',mode:'fingerprint'})).status,405);
});
test('host verification fingerprint format and constant time compare',()=>{
  assert.match(ssh._test.fingerprintOf(Buffer.from('example')), /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.ok(ssh._test.secureEqual('abc','abc'));
  assert.equal(ssh._test.secureEqual('abc','abd'),false);
});