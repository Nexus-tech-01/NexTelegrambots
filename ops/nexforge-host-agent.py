#!/usr/bin/env python3
import asyncio, base64, hashlib, json, os, platform, shutil, subprocess, sys, time, urllib.request, secrets
from pathlib import Path

VERSION="1.3.0"
SB_URL=os.environ.get("SUPABASE_URL","").rstrip("/")
PUB=os.environ.get("PUBLISHABLE_KEY","")
SETUP=os.environ.get("SETUP_TOKEN","")
AGENT_ID=os.environ.get("AGENT_ID","")
AGENT_KEY=os.environ.get("AGENT_KEY","")
AGENT_NAME=os.environ.get("AGENT_NAME",platform.node() or "NexControl Host")
ENV_FILE="/etc/nexforge-host-agent.env"
BACKUP_DIR=Path("/var/lib/nexforge-host-agent/backups")
BACKUP_DIR.mkdir(parents=True,exist_ok=True)

def rpc(name,payload):
    data=json.dumps(payload).encode()
    req=urllib.request.Request(
        SB_URL+"/rest/v1/rpc/"+name,
        data=data,
        headers={"content-type":"application/json","apikey":PUB,"authorization":"Bearer "+PUB},
        method="POST",
    )
    with urllib.request.urlopen(req,timeout=30) as r:
        return json.loads((r.read() or b"{}").decode())

def meta():
    return {
        "name":AGENT_NAME,
        "hostname":platform.node(),
        "os":platform.platform(),
        "kernel":platform.release(),
        "arch":platform.machine(),
        "version":VERSION,
        "capabilities":{
            "root":os.geteuid()==0,
            "tty":False,
            "jobs":[
                "exec","fs.list","fs.read","fs.write","fs.mkdir","fs.move","fs.copy",
                "fs.delete","fs.chmod","system.info","process.list","disk.usage",
                "net.info","systemd","docker"
            ]
        }
    }

def sq(v):
    return "'" + str(v).replace("'","'\\''") + "'"

def persist(agent_id,agent_key):
    global AGENT_ID,AGENT_KEY,SETUP
    AGENT_ID,AGENT_KEY,SETUP=str(agent_id),str(agent_key),""
    lines=[
        "SUPABASE_URL="+sq(SB_URL),
        "PUBLISHABLE_KEY="+sq(PUB),
        "AGENT_ID="+sq(AGENT_ID),
        "AGENT_KEY="+sq(AGENT_KEY),
        "AGENT_NAME="+sq(AGENT_NAME),
    ]
    Path(ENV_FILE).write_text("\n".join(lines)+"\n")
    os.chmod(ENV_FILE,0o600)

def ensure_registered():
    global AGENT_ID,AGENT_KEY
    if AGENT_ID and AGENT_KEY:
        return
    if not SETUP:
        raise RuntimeError("Missing SETUP_TOKEN")
    r=rpc("nxf_host_register",{"p_setup_token":SETUP,"p_meta":meta()})
    if not r.get("ok"):
        raise RuntimeError("Registration failed")
    persist(r["agent_id"],r["agent_key"])

def run(cmd,timeout=90,cwd="/"):
    p=subprocess.run(["/bin/bash","-lc",cmd],cwd=cwd,capture_output=True,text=True,timeout=timeout)
    return {"code":p.returncode,"stdout":p.stdout[-1000000:],"stderr":p.stderr[-1000000:]}

def backup(path,job_id):
    p=Path(path)
    if not p.exists() or not p.is_file():
        return None
    dest=BACKUP_DIR/(str(job_id)+"-"+str(int(time.time()))+".bak")
    shutil.copy2(p,dest)
    return str(dest)

def job_exec(job):
    jid=str(job["id"]); kind=str(job["kind"]); p=job.get("payload") or {}
    if kind=="exec":
        return run(str(p.get("command") or p.get("shell") or ""),int(p.get("timeout",90)),str(p.get("cwd") or "/"))
    if kind=="fs.list":
        path=Path(str(p.get("path") or "/"))
        items=[]
        for x in sorted(path.iterdir(),key=lambda z:(not z.is_dir(),z.name.lower()))[:2000]:
            st=x.lstat()
            items.append({"name":x.name,"path":str(x),"type":"directory" if x.is_dir() else "file","size":st.st_size,"mode":oct(st.st_mode & 0o777),"mtime":st.st_mtime})
        return {"path":str(path),"items":items}
    if kind=="fs.read":
        path=Path(str(p.get("path") or ""))
        b=path.read_bytes()
        if len(b)>4*1024*1024: raise RuntimeError("file_too_large")
        try:return {"path":str(path),"binary":False,"content":b.decode("utf-8"),"size":len(b)}
        except UnicodeDecodeError:return {"path":str(path),"binary":True,"content_b64":base64.b64encode(b).decode(),"size":len(b)}
    if kind=="fs.write":
        path=Path(str(p.get("path") or ""))
        if not path.is_absolute(): raise RuntimeError("absolute_path_required")
        path.parent.mkdir(parents=True,exist_ok=True)
        bak=backup(path,jid)
        old_mode=(path.stat().st_mode & 0o777) if path.exists() else 0o644
        data=base64.b64decode(str(p.get("content_b64"))) if p.get("content_b64") is not None else str(p.get("content") or "").encode()
        tmp=path.with_name(path.name+".nxf-tmp-"+secrets.token_hex(4))
        tmp.write_bytes(data); os.chmod(tmp,old_mode); os.replace(tmp,path)
        return {"ok":True,"path":str(path),"bytes":len(data),"backup":bak}
    if kind=="fs.mkdir":
        path=Path(str(p.get("path") or "")); path.mkdir(parents=bool(p.get("parents",True)),exist_ok=True); return {"ok":True,"path":str(path)}
    if kind=="fs.move":
        shutil.move(str(p.get("src")),str(p.get("dst"))); return {"ok":True}
    if kind=="fs.copy":
        src=Path(str(p.get("src"))); dst=Path(str(p.get("dst")))
        if src.is_dir(): shutil.copytree(src,dst,dirs_exist_ok=True)
        else: shutil.copy2(src,dst)
        return {"ok":True}
    if kind=="fs.delete":
        path=Path(str(p.get("path") or ""))
        if str(path) in ("/","/etc","/usr","/var","/home","/root"): raise RuntimeError("protected_path")
        if path.is_dir() and not path.is_symlink(): shutil.rmtree(path)
        else: path.unlink(missing_ok=True)
        return {"ok":True}
    if kind=="fs.chmod":
        path=Path(str(p.get("path"))); mode=int(str(p.get("mode") or "644"),8); os.chmod(path,mode); return {"ok":True,"mode":oct(mode)}
    if kind=="system.info":
        return {"uname":platform.uname()._asdict(),"boot":run("uptime -p; who -b || true"),"mem":run("free -h || cat /proc/meminfo | head -30"),"cpu":run("nproc; lscpu | head -30 || true")}
    if kind=="process.list": return run("ps auxww --sort=-%mem | head -120")
    if kind=="disk.usage": return run("df -hT; echo; lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS 2>/dev/null || true")
    if kind=="net.info": return run("ip -br addr 2>/dev/null || true; echo; ip route 2>/dev/null || true; echo; ss -tulpn 2>/dev/null | head -200 || true")
    if kind=="systemd":
        action=str(p.get("action") or "list"); service=str(p.get("service") or "")
        if action=="list": return run("systemctl --no-pager --type=service --state=running,failed | head -200")
        if action=="status": return run("systemctl --no-pager status "+sq(service)+" || true")
        if action not in ("start","stop","restart","reload","enable","disable"): raise RuntimeError("invalid_systemd_action")
        return run("systemctl "+action+" "+sq(service),90)
    if kind=="docker":
        action=str(p.get("action") or "ps"); target=str(p.get("target") or "")
        if action=="ps": return run("docker ps -a --no-trunc")
        if action=="logs": return run("docker logs --tail 300 "+sq(target)+" 2>&1",90)
        if action not in ("start","stop","restart","kill"): raise RuntimeError("invalid_docker_action")
        return run("docker "+action+" "+sq(target),90)
    raise RuntimeError("unsupported_job:"+kind)

async def result(job,ok,value=None,error=None):
    await asyncio.to_thread(rpc,"nxf_host_result",{
        "p_agent_id":AGENT_ID,"p_agent_key":AGENT_KEY,"p_job_id":job["id"],
        "p_ok":bool(ok),"p_result":value or {},"p_error":error
    })

async def heartbeat_loop():
    while True:
        try:
            await asyncio.to_thread(rpc,"nxf_host_heartbeat",{"p_agent_id":AGENT_ID,"p_agent_key":AGENT_KEY,"p_meta":meta()})
        except Exception as e:
            print("heartbeat error:",e,flush=True)
        await asyncio.sleep(5)

async def poll_loop():
    while True:
        try:
            r=await asyncio.to_thread(rpc,"nxf_host_poll",{"p_agent_id":AGENT_ID,"p_agent_key":AGENT_KEY,"p_meta":meta()})
            for job in r.get("jobs") or []:
                try:
                    value=await asyncio.to_thread(job_exec,job)
                    await result(job,True,value,None)
                except Exception as e:
                    await result(job,False,{},str(e))
        except Exception as e:
            print("poll error:",e,flush=True)
        await asyncio.sleep(5)

async def main():
    if os.geteuid()!=0:
        print("NexControl host agent must run as root",file=sys.stderr); sys.exit(1)
    if not SB_URL or not PUB:
        print("Missing Supabase configuration",file=sys.stderr); sys.exit(1)
    ensure_registered()
    print("NexControl Host Agent",VERSION,"online as",AGENT_ID,flush=True)
    await asyncio.gather(poll_loop(),heartbeat_loop())

if __name__=="__main__":
    asyncio.run(main())
