
import { createClient } from "npm:@supabase/supabase-js@2";
import { Client as SSHClient } from "npm:ssh2@1.17.0";

const sb = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const te = new TextEncoder();
const SESSION_SECONDS = 43200;

async function sha(v) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(String(v || ""))));
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}
function token() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}
function getCookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const p = part.trim();
    const i = p.indexOf("=");
    if (i > 0 && p.slice(0, i) === name) return decodeURIComponent(p.slice(i + 1));
  }
  return "";
}
async function readBody(req) {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("json")) return await req.json().catch(() => ({}));
  return Object.fromEntries(new URLSearchParams(await req.text()));
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
}
function html(data, status = 200, extra = {}) {
  return new Response(data, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra } });
}
async function admin(req) {
  const raw = getCookie(req, "nxc_session");
  if (!raw) return false;
  const h = await sha(raw);
  const { data } = await sb.from("nxc_sessions").select("expires_at").eq("token_hash", h).maybeSingle();
  return !!data && new Date(data.expires_at).getTime() > Date.now();
}
async function doLogin(password) {
  const { data } = await sb.from("nxc_config").select("value").eq("key", "ADMIN_PASSWORD_HASH").maybeSingle();
  if (!data || await sha(password) !== data.value) return "";
  const raw = token();
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  const { error } = await sb.from("nxc_sessions").insert({ token_hash: await sha(raw), expires_at: exp, created_at: now });
  if (error) throw error;
  return raw;
}
async function doLogout(req) {
  const raw = getCookie(req, "nxc_session");
  if (raw) await sb.from("nxc_sessions").delete().eq("token_hash", await sha(raw));
}
async function bundle() {
  const { data, error } = await sb.rpc("nxc_external_watchdog_secret_bundle");
  if (error) throw error;
  const x = Array.isArray(data) ? data[0] : data;
  if (!x || !x.panel_url || !x.server_identifier || !x.pterodactyl_api_key) throw new Error("Pterodactyl configuration unavailable");
  return { panel: String(x.panel_url).replace(/\/+$/, ""), id: String(x.server_identifier), key: String(x.pterodactyl_api_key) };
}
async function ptero(path, init = {}) {
  const c = await bundle();
  const h = new Headers(init.headers || {});
  h.set("Authorization", "Bearer " + c.key);
  h.set("Accept", "Application/vnd.pterodactyl.v1+json");
  if (init.body && !h.has("content-type")) h.set("content-type", "application/json");
  const url = c.panel + path.replace(":id", encodeURIComponent(c.id));
  const r = await fetch(url, { ...init, headers: h });
  const ct = r.headers.get("content-type") || "";
  const out = ct.includes("json") ? await r.json().catch(() => ({})) : await r.text();
  if (!r.ok) throw new Error("Pterodactyl " + r.status + " " + JSON.stringify(out).slice(0, 400));
  return out;
}
async function agents() {
  const { data, error } = await sb.from("nxc_agents").select("id,slug,display_name,hostname,platform,node_version,last_heartbeat_at,roots,capabilities,enabled").eq("enabled", true).order("display_name");
  if (error) throw error;
  return data || [];
}
async function makeJob(agentId, kind, payload) {
  const allowed = ["fs.list","fs.read","fs.write","logs.tail","system.info","process.list","disk.usage","runtime.exec","runtime.restart"];
  if (!allowed.includes(kind)) throw new Error("Unsupported operation");
  const { data: a } = await sb.from("nxc_agents").select("id,enabled").eq("id", agentId).maybeSingle();
  if (!a || !a.enabled) throw new Error("Agent not found");
  if (kind === "runtime.exec") {
    const command = String(payload.shell || "").trim();
    if (!command) throw new Error("Empty command");
    payload = { root: String(payload.root || "nexus"), command: "/bin/sh", args: ["-lc", command], timeoutMs: Math.min(120000, Math.max(1000, Number(payload.timeoutMs) || 60000)) };
  }
  const now = new Date().toISOString();
  const { data, error } = await sb.from("nxc_agent_jobs").insert({
    agent_id: agentId, kind, payload: payload || {}, status: "pending",
    available_at: now, created_by: "admin", created_at: now, updated_at: now
  }).select("id,status").single();
  if (error) throw error;
  return data;
}


const HOST_PUBLISHABLE = "sb_publishable_EnV_q5ePfEOB1NxN3-gtpA_HdwjtPyu";
const HOST_AGENT_PY = "#!/usr/bin/env python3\nimport asyncio, base64, fcntl, json, os, platform, pty, re, shutil, signal, struct, subprocess, sys, time, urllib.request, urllib.error, secrets\nfrom pathlib import Path\ntry:\n    import websockets\nexcept Exception:\n    websockets=None\nfrom urllib.parse import urlparse, parse_qs\n\nVERSION=\"1.1.0\"\nSB_URL=os.environ.get(\"SUPABASE_URL\",\"\").rstrip(\"/\")\nPUB=os.environ.get(\"PUBLISHABLE_KEY\",\"\")\nSETUP=os.environ.get(\"SETUP_TOKEN\",\"\")\nAGENT_ID=os.environ.get(\"AGENT_ID\",\"\")\nAGENT_KEY=os.environ.get(\"AGENT_KEY\",\"\")\nAGENT_NAME=os.environ.get(\"AGENT_NAME\", platform.node() or \"NexForge Host\")\nENV_FILE=\"/etc/nexforge-host-agent.env\"\nBACKUP_DIR=Path(\"/var/lib/nexforge-host-agent/backups\")\nBACKUP_DIR.mkdir(parents=True, exist_ok=True)\nTICKETS={}\nTUNNEL_URL=\"\"\n\ndef rpc(name,payload):\n    data=json.dumps(payload).encode()\n    req=urllib.request.Request(\n        SB_URL+\"/rest/v1/rpc/\"+name,\n        data=data,\n        headers={\"content-type\":\"application/json\",\"apikey\":PUB,\"authorization\":\"Bearer \"+PUB},\n        method=\"POST\",\n    )\n    with urllib.request.urlopen(req, timeout=30) as r:\n        raw=r.read()\n        return json.loads(raw.decode() or \"{}\")\n\ndef meta():\n    return {\n        \"name\": AGENT_NAME,\n        \"hostname\": platform.node(),\n        \"os\": platform.platform(),\n        \"kernel\": platform.release(),\n        \"arch\": platform.machine(),\n        \"version\": VERSION,\n        \"capabilities\": {\n            \"root\": os.geteuid()==0,\n            \"tty\": bool(websockets and shutil.which(\"cloudflared\")),\n            \"tunnel_url\": TUNNEL_URL,\n            \"jobs\": [\"exec\",\"fs.list\",\"fs.read\",\"fs.write\",\"fs.mkdir\",\"fs.move\",\"fs.copy\",\"fs.delete\",\"fs.chmod\",\"system.info\",\"process.list\",\"disk.usage\",\"net.info\",\"systemd\",\"docker\",\"pty.ticket\"]\n        }\n    }\n\ndef q(v):\n    return \"'\" + str(v).replace(\"'\", \"'\\\"'\\\"'\") + \"'\"\n\ndef persist_credentials(agent_id, agent_key):\n    global AGENT_ID, AGENT_KEY, SETUP\n    AGENT_ID, AGENT_KEY, SETUP = agent_id, agent_key, \"\"\n    lines = [\n        \"SUPABASE_URL=\"+q(SB_URL),\n        \"PUBLISHABLE_KEY=\"+q(PUB),\n        \"AGENT_ID=\"+q(AGENT_ID),\n        \"AGENT_KEY=\"+q(AGENT_KEY),\n        \"AGENT_NAME=\"+q(AGENT_NAME),\n    ]\n    Path(ENV_FILE).write_text(\"\\n\".join(lines)+\"\\n\")\n    os.chmod(ENV_FILE,0o600)\n\ndef ensure_registered():\n    global AGENT_ID, AGENT_KEY\n    if AGENT_ID and AGENT_KEY:\n        return\n    if not SETUP:\n        raise RuntimeError(\"Missing SETUP_TOKEN\")\n    r=rpc(\"nxf_host_register\",{\"p_setup_token\":SETUP,\"p_meta\":meta()})\n    if not r.get(\"ok\"):\n        raise RuntimeError(\"Registration failed\")\n    persist_credentials(str(r[\"agent_id\"]),str(r[\"agent_key\"]))\n\ndef run(cmd, timeout=60, cwd=\"/\"):\n    p=subprocess.run([\"/bin/bash\",\"-lc\",cmd],cwd=cwd,capture_output=True,text=True,timeout=timeout)\n    return {\"code\":p.returncode,\"stdout\":p.stdout[-1000000:],\"stderr\":p.stderr[-1000000:]}\n\ndef safe_backup(path, job_id):\n    p=Path(path)\n    if not p.exists() or not p.is_file():\n        return None\n    stamp=str(int(time.time()))\n    dest=BACKUP_DIR/(str(job_id)+\"-\"+stamp+\".bak\")\n    shutil.copy2(p,dest)\n    return str(dest)\n\ndef job_exec(job):\n    jid=str(job[\"id\"]); kind=str(job[\"kind\"]); p=job.get(\"payload\") or {}\n    if kind==\"exec\":\n        return run(str(p.get(\"command\") or p.get(\"shell\") or \"\"), int(p.get(\"timeout\",90)), str(p.get(\"cwd\") or \"/\"))\n    if kind==\"fs.list\":\n        path=Path(str(p.get(\"path\") or \"/\"))\n        items=[]\n        for x in sorted(path.iterdir(), key=lambda z:(not z.is_dir(),z.name.lower()))[:2000]:\n            st=x.lstat()\n            items.append({\"name\":x.name,\"path\":str(x),\"type\":\"directory\" if x.is_dir() else \"file\",\"size\":st.st_size,\"mode\":oct(st.st_mode & 0o777),\"mtime\":st.st_mtime})\n        return {\"path\":str(path),\"items\":items}\n    if kind==\"fs.read\":\n        path=Path(str(p.get(\"path\") or \"\"))\n        b=path.read_bytes()\n        if len(b)>4*1024*1024: raise RuntimeError(\"file_too_large\")\n        try:\n            return {\"path\":str(path),\"binary\":False,\"content\":b.decode(\"utf-8\"),\"size\":len(b)}\n        except UnicodeDecodeError:\n            return {\"path\":str(path),\"binary\":True,\"content_b64\":base64.b64encode(b).decode(),\"size\":len(b)}\n    if kind==\"fs.write\":\n        path=Path(str(p.get(\"path\") or \"\"))\n        if not path.is_absolute(): raise RuntimeError(\"absolute_path_required\")\n        path.parent.mkdir(parents=True,exist_ok=True)\n        backup=safe_backup(path,jid)\n        old_mode=(path.stat().st_mode & 0o777) if path.exists() else 0o644\n        data=base64.b64decode(str(p.get(\"content_b64\"))) if p.get(\"content_b64\") is not None else str(p.get(\"content\") or \"\").encode()\n        tmp=path.with_name(path.name+\".nxf-tmp-\"+secrets.token_hex(4))\n        tmp.write_bytes(data); os.chmod(tmp,old_mode); os.replace(tmp,path)\n        return {\"ok\":True,\"path\":str(path),\"bytes\":len(data),\"backup\":backup}\n    if kind==\"fs.mkdir\":\n        path=Path(str(p.get(\"path\") or \"\")); path.mkdir(parents=bool(p.get(\"parents\",True)),exist_ok=True); return {\"ok\":True,\"path\":str(path)}\n    if kind==\"fs.move\":\n        shutil.move(str(p.get(\"src\")),str(p.get(\"dst\"))); return {\"ok\":True}\n    if kind==\"fs.copy\":\n        src=Path(str(p.get(\"src\"))); dst=Path(str(p.get(\"dst\")))\n        if src.is_dir(): shutil.copytree(src,dst,dirs_exist_ok=True)\n        else: shutil.copy2(src,dst)\n        return {\"ok\":True}\n    if kind==\"fs.delete\":\n        path=Path(str(p.get(\"path\") or \"\"))\n        if str(path) in (\"/\",\"/etc\",\"/usr\",\"/var\",\"/home\",\"/root\"): raise RuntimeError(\"protected_path\")\n        if path.is_dir() and not path.is_symlink(): shutil.rmtree(path)\n        else: path.unlink(missing_ok=True)\n        return {\"ok\":True}\n    if kind==\"fs.chmod\":\n        path=Path(str(p.get(\"path\"))); mode=int(str(p.get(\"mode\") or \"644\"),8); os.chmod(path,mode); return {\"ok\":True,\"mode\":oct(mode)}\n    if kind==\"system.info\":\n        return {\"uname\":platform.uname()._asdict(),\"boot\":run(\"uptime -p; who -b || true\"),\"mem\":run(\"free -h || cat /proc/meminfo | head -30\"),\"cpu\":run(\"nproc; lscpu | head -30 || true\")}\n    if kind==\"process.list\":\n        return run(\"ps auxww --sort=-%mem | head -120\")\n    if kind==\"disk.usage\":\n        return run(\"df -hT; echo; lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS 2>/dev/null || true\")\n    if kind==\"net.info\":\n        return run(\"ip -br addr 2>/dev/null || true; echo; ip route 2>/dev/null || true; echo; ss -tulpn 2>/dev/null | head -200 || true\")\n    if kind==\"systemd\":\n        action=str(p.get(\"action\") or \"list\")\n        service=str(p.get(\"service\") or \"\")\n        if action==\"list\": return run(\"systemctl --no-pager --type=service --state=running,failed | head -200\")\n        if action==\"status\": return run(\"systemctl --no-pager status \"+q(service)+\" || true\")\n        if action not in (\"start\",\"stop\",\"restart\",\"reload\",\"enable\",\"disable\"): raise RuntimeError(\"invalid_systemd_action\")\n        return run(\"systemctl \"+action+\" \"+q(service),90)\n    if kind==\"docker\":\n        action=str(p.get(\"action\") or \"ps\"); target=str(p.get(\"target\") or \"\")\n        if action==\"ps\": return run(\"docker ps -a --no-trunc\")\n        if action==\"logs\": return run(\"docker logs --tail 300 \"+q(target)+\" 2>&1\",90)\n        if action not in (\"start\",\"stop\",\"restart\",\"kill\"): raise RuntimeError(\"invalid_docker_action\")\n        return run(\"docker \"+action+\" \"+q(target),90)\n    if kind==\"pty.ticket\":\n        if not TUNNEL_URL: raise RuntimeError(\"interactive_tunnel_unavailable\")\n        ticket=secrets.token_urlsafe(32); TICKETS[ticket]=time.time()+60\n        return {\"ticket\":ticket,\"tunnel_url\":TUNNEL_URL,\"expires_in\":60}\n    raise RuntimeError(\"unsupported_job:\"+kind)\n\nasync def send_result(job, ok, result=None, error=None):\n    payload={\"p_agent_id\":AGENT_ID,\"p_agent_key\":AGENT_KEY,\"p_job_id\":job[\"id\"],\"p_ok\":bool(ok),\"p_result\":result or {},\"p_error\":error}\n    await asyncio.to_thread(rpc,\"nxf_host_result\",payload)\n\nasync def poll_loop():\n    ensure_registered()\n    while True:\n        try:\n            r=await asyncio.to_thread(rpc,\"nxf_host_poll\",{\"p_agent_id\":AGENT_ID,\"p_agent_key\":AGENT_KEY,\"p_meta\":meta()})\n            for job in r.get(\"jobs\") or []:\n                try:\n                    res=await asyncio.to_thread(job_exec,job)\n                    await send_result(job,True,res,None)\n                except Exception as e:\n                    await send_result(job,False,{},str(e))\n        except Exception as e:\n            print(\"poll error:\",e,flush=True)\n        await asyncio.sleep(5)\n\nasync def ws_handler(ws, path):\n    try:\n        qs=parse_qs(urlparse(path).query)\n        ticket=(qs.get(\"ticket\") or [\"\"])[0]\n        exp=TICKETS.pop(ticket,None)\n        if not exp or exp<time.time():\n            await ws.close(code=4401,reason=\"invalid ticket\"); return\n        master,slave=pty.openpty()\n        proc=subprocess.Popen([\"/bin/bash\",\"-l\"],stdin=slave,stdout=slave,stderr=slave,cwd=\"/\",start_new_session=True,close_fds=True)\n        os.close(slave)\n        async def reader():\n            while proc.poll() is None:\n                try:\n                    data=await asyncio.to_thread(os.read,master,8192)\n                    if not data: break\n                    await ws.send(data)\n                except Exception:\n                    break\n        rt=asyncio.create_task(reader())\n        try:\n            async for msg in ws:\n                if isinstance(msg,bytes):\n                    os.write(master,msg); continue\n                try:\n                    j=json.loads(msg)\n                    if j.get(\"type\")==\"input\": os.write(master,str(j.get(\"data\") or \"\").encode())\n                    elif j.get(\"type\")==\"resize\":\n                        rows=max(2,int(j.get(\"rows\") or 24)); cols=max(10,int(j.get(\"cols\") or 80))\n                        fcntl.ioctl(master,0x5414,struct.pack(\"HHHH\",rows,cols,0,0))\n                except Exception:\n                    os.write(master,str(msg).encode())\n        finally:\n            try: os.killpg(os.getpgid(proc.pid),signal.SIGHUP)\n            except Exception: pass\n            try: os.close(master)\n            except Exception: pass\n            rt.cancel()\n    except Exception:\n        try: await ws.close()\n        except Exception: pass\n\nasync def tunnel_loop():\n    global TUNNEL_URL\n    while True:\n        try:\n            p=await asyncio.create_subprocess_exec(\"/usr/local/bin/cloudflared\",\"tunnel\",\"--url\",\"http://127.0.0.1:8765\",\"--no-autoupdate\",stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)\n            while True:\n                line=await p.stderr.readline()\n                if not line: break\n                text=line.decode(errors=\"replace\").strip()\n                print(text,flush=True)\n                m=re.search(r\"https://[a-z0-9-]+\\.trycloudflare\\.com\",text)\n                if m:\n                    TUNNEL_URL=m.group(0)\n                    print(\"tunnel:\",TUNNEL_URL,flush=True)\n            TUNNEL_URL=\"\"\n            await p.wait()\n        except Exception as e:\n            print(\"tunnel error:\",e,flush=True)\n        await asyncio.sleep(5)\n\nasync def main():\n    if os.geteuid()!=0:\n        print(\"NexForge host agent must run as root\",file=sys.stderr); sys.exit(1)\n    ensure_registered()\n    if websockets and shutil.which(\"cloudflared\"):\n        async with websockets.serve(ws_handler,\"127.0.0.1\",8765,max_size=4*1024*1024,ping_interval=20,ping_timeout=20):\n            await asyncio.gather(poll_loop(),tunnel_loop())\n    else:\n        print(\"NexForge core online; interactive TTY extras not ready yet\",flush=True)\n        await poll_loop()\n\nif __name__==\"__main__\":\n    asyncio.run(main())\n";

async function hostSetupToken() {
  const raw = "nxf_setup_" + token();
  const expires = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const { error } = await sb.from("nxc_host_setup_tokens").insert({ token_hash: await sha(raw), expires_at: expires });
  if (error) throw error;
  return { token: raw, expires_at: expires };
}
async function validHostSetup(raw) {
  if (!raw) return false;
  const { data } = await sb.from("nxc_host_setup_tokens").select("expires_at,used_at").eq("token_hash", await sha(raw)).maybeSingle();
  return !!data && !data.used_at && new Date(data.expires_at).getTime() > Date.now();
}
function hostInstallScript(setup) {
  const sbUrl = String(Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/,"");
  const env = [
    "SUPABASE_URL=" + JSON.stringify(sbUrl),
    "PUBLISHABLE_KEY=" + JSON.stringify(HOST_PUBLISHABLE),
    "SETUP_TOKEN=" + JSON.stringify(setup),
    "AGENT_NAME=\"NexForge Host\""
  ].join("\n");
  const unit = "[Unit]\nDescription=NexForge Host Agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironmentFile=/etc/nexforge-host-agent.env\nExecStart=/usr/bin/python3 /opt/nexforge-host-agent/agent.py\nRestart=always\nRestartSec=4\nUser=root\nWorkingDirectory=/opt/nexforge-host-agent\nNoNewPrivileges=false\n\n[Install]\nWantedBy=multi-user.target\n";
  return "#!/usr/bin/env bash\nset -euo pipefail\n" +
    "if [ \"$(id -u)\" -ne 0 ]; then echo 'Run with sudo/root'; exit 1; fi\n" +
    "echo '[NexForge] Phase 1/2: core agent'\n" +
    "command -v python3 >/dev/null 2>&1 || { echo 'python3_missing'; exit 1; }\n" +
    "mkdir -p /opt/nexforge-host-agent /var/lib/nexforge-host-agent/backups\n" +
    "cat >/opt/nexforge-host-agent/agent.py <<'NXF_AGENT'\n" + HOST_AGENT_PY + "\nNXF_AGENT\n" +
    "chmod 0700 /opt/nexforge-host-agent/agent.py\n" +
    "cat >/etc/nexforge-host-agent.env <<'NXF_ENV'\n" + env + "\nNXF_ENV\n" +
    "chmod 0600 /etc/nexforge-host-agent.env\n" +
    "cat >/etc/systemd/system/nexforge-host-agent.service <<'NXF_UNIT'\n" + unit + "NXF_UNIT\n" +
    "systemctl daemon-reload\n" +
    "systemctl enable nexforge-host-agent.service >/dev/null\n" +
    "systemctl restart nexforge-host-agent.service\n" +
    "echo '[NexForge] Core agent started'\n" +
    "for i in 1 2 3 4 5 6 7 8 9 10; do systemctl is-active --quiet nexforge-host-agent.service && break; sleep 1; done\n" +
    "systemctl is-active --quiet nexforge-host-agent.service || { journalctl -u nexforge-host-agent.service -n 60 --no-pager; exit 1; }\n" +
    "echo '[NexForge] Phase 2/2: optional TTY extras scheduled in background'\n" +
    "(\n" +
    "  set +e\n" +
    "  if command -v apt-get >/dev/null 2>&1; then\n" +
    "    timeout 120s apt-get update -y >/var/log/nexforge-extras.log 2>&1\n" +
    "    timeout 120s env DEBIAN_FRONTEND=noninteractive apt-get install -y python3-pip ca-certificates curl >>/var/log/nexforge-extras.log 2>&1\n" +
    "  fi\n" +
    "  timeout 120s python3 -m pip install --break-system-packages --disable-pip-version-check --no-cache-dir websockets==12.0 >>/var/log/nexforge-extras.log 2>&1 || true\n" +
    "  if command -v curl >/dev/null 2>&1; then\n" +
    "    ARCH=$(uname -m); case \"$ARCH\" in x86_64|amd64) CFARCH=amd64;; aarch64|arm64) CFARCH=arm64;; *) CFARCH='';; esac\n" +
    "    if [ -n \"$CFARCH\" ]; then timeout 120s curl -fsSL \"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CFARCH\" -o /usr/local/bin/cloudflared && chmod 0755 /usr/local/bin/cloudflared; fi\n" +
    "  fi\n" +
    "  systemctl restart nexforge-host-agent.service\n" +
    ") >/dev/null 2>&1 &\n" +
    "echo '[NexForge] Core installation complete; host registration should appear within seconds.'\n";
}

async function hostAgentsList() {
  const { data, error } = await sb.from("nxc_host_agents").select("id,name,hostname,os,kernel,arch,version,capabilities,enabled,last_seen_at,created_at").eq("enabled",true).order("created_at",{ascending:false});
  if (error) throw error; return data || [];
}
async function makeHostJob(agentId, kind, payload) {
  const allowed = ["exec","fs.list","fs.read","fs.write","fs.mkdir","fs.move","fs.copy","fs.delete","fs.chmod","system.info","process.list","disk.usage","net.info","systemd","docker","pty.ticket"];
  if (!allowed.includes(kind)) throw new Error("Unsupported host operation");
  const { data: a } = await sb.from("nxc_host_agents").select("id,enabled").eq("id",agentId).maybeSingle();
  if (!a || !a.enabled) throw new Error("Host agent not found");
  const now = new Date().toISOString();
  const { data, error } = await sb.from("nxc_host_jobs").insert({agent_id:agentId,kind,payload:payload||{},status:"pending",created_at:now,updated_at:now}).select("id,status").single();
  if (error) throw error; return data;
}
async function hostJobStatus(id) {
  const { data, error } = await sb.from("nxc_host_jobs").select("id,kind,status,result,error,created_at,completed_at").eq("id",id).maybeSingle();
  if (error) throw error; return data;
}


function shellQuote(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}
async function bootstrapHostSsh(host, port, username, password) {
  host = String(host || "").trim();
  username = String(username || "root").trim();
  port = Number(port || 22);
  password = String(password || "");
  if (!/^[a-zA-Z0-9._:-]{1,255}$/.test(host)) throw new Error("invalid_host");
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username)) throw new Error("invalid_username");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_port");
  if (!password || password.length > 2048) throw new Error("password_required");

  const candidates = [...new Set([username, ...(username === "root" ? ["debian"] : [])])];
  let lastAuthError = null;

  for (const authUser of candidates) {
    try {
      const setup = await hostSetupToken();
      const script = hostInstallScript(setup.token);
      const scriptBytes = new TextEncoder().encode(script);
      let binary = "";
      for (const b of scriptBytes) binary += String.fromCharCode(b);
      const scriptB64 = btoa(binary);
      const remotePath = "/tmp/nexforge-install-" + crypto.randomUUID().slice(0,8) + ".sh";

      const result = await new Promise((resolve, reject) => {
        const conn = new SSHClient();
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          try { conn.end(); } catch {}
          fn(value);
        };
        const timer = setTimeout(() => finish(reject, new Error("ssh_timeout")), 60000);

        conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finishKb) => {
          try { finishKb(prompts.map(() => password)); }
          catch { finishKb([]); }
        });

        conn.on("ready", () => {
          const upload = "printf %s " + shellQuote(scriptB64) + " | base64 -d > " + shellQuote(remotePath) + " && chmod 700 " + shellQuote(remotePath);
          conn.exec(upload, (uploadErr, uploadStream) => {
            if (uploadErr) {
              clearTimeout(timer);
              finish(reject, new Error("bootstrap_upload_failed: " + String(uploadErr?.message || uploadErr)));
              return;
            }
            let uploadErrOut = "";
            uploadStream.stderr.on("data", d => { uploadErrOut += String(d); });
            uploadStream.on("close", (uploadCode) => {
              if (uploadCode !== 0) {
                clearTimeout(timer);
                finish(reject, new Error("bootstrap_upload_failed: " + uploadErrOut.slice(-1200)));
                return;
              }

              const runCommand = authUser === "root"
                ? "bash " + shellQuote(remotePath) + "; code=$?; rm -f " + shellQuote(remotePath) + "; exit $code"
                : "printf %s\\n " + shellQuote(password) + " | sudo -S -p '' bash " + shellQuote(remotePath) + "; code=$?; rm -f " + shellQuote(remotePath) + "; exit $code";

              conn.exec(runCommand, (runErr, stream) => {
                if (runErr) {
                  clearTimeout(timer);
                  finish(reject, new Error("bootstrap_exec_failed: " + String(runErr?.message || runErr)));
                  return;
                }
                let out = "", errOut = "";
                stream.on("data", d => { out += String(d); if (out.length > 120000) out = out.slice(-120000); });
                stream.stderr.on("data", d => { errOut += String(d); if (errOut.length > 120000) errOut = errOut.slice(-120000); });
                stream.on("close", (code) => {
                  clearTimeout(timer);
                  if (code !== 0) {
                    finish(reject, new Error("bootstrap_install_failed_for_" + authUser + ": " + (errOut || out).slice(-4000)));
                  } else {
                    finish(resolve, {
                      ok: true,
                      username: authUser,
                      setup_expires_at: setup.expires_at,
                      output: (out + (errOut ? "\n" + errOut : "")).slice(-6000)
                    });
                  }
                });
              });
            });
          });
        });

        conn.on("error", (e) => {
          clearTimeout(timer);
          const msg = String(e?.message || e);
          if (/authentication|configured authentication methods failed/i.test(msg)) {
            finish(reject, new Error("ssh_authentication_failed_for_" + authUser));
          } else {
            finish(reject, new Error("ssh_connection_failed_for_" + authUser + ": " + msg.slice(0,300)));
          }
        });

        try {
          conn.connect({
            host,
            port,
            username: authUser,
            password,
            tryKeyboard: true,
            readyTimeout: 20000,
            keepaliveInterval: 5000,
            keepaliveCountMax: 2
          });
        } catch (e) {
          clearTimeout(timer);
          finish(reject, e);
        }
      });

      return result;
    } catch (e) {
      const msg = String(e?.message || e);
      lastAuthError = msg;
      if (!/ssh_authentication_failed_for_/.test(msg)) throw e;
    }
  }

  throw new Error(
    "ssh_authentication_failed_all_methods: " + candidates.join(",") +
    (lastAuthError ? " · " + lastAuthError : "")
  );
}

function hostPage() {
return html(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NexForge · Host Root</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css"><style>${CSS}
.hosthead{display:flex;justify-content:space-between;gap:12px;align-items:center}.hostgrid{display:grid;grid-template-columns:320px 1fr;gap:12px}.sidepanel,.mainpanel{border:1px solid var(--l);border-radius:22px;background:#101219dd;padding:16px}.hostitem{border:1px solid var(--l);border-radius:14px;padding:12px;margin-top:8px;cursor:pointer}.hostitem.sel{border-color:var(--a);background:#18152a}.install{white-space:pre-wrap;word-break:break-all;background:#050607;border:1px solid var(--l);border-radius:14px;padding:12px;font:12px ui-monospace,monospace}.xtermwrap{height:520px;background:#030405;border-radius:16px;padding:10px;overflow:hidden}.quick{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}@media(max-width:950px){.hostgrid{grid-template-columns:1fr}.quick{grid-template-columns:1fr 1fr}.xtermwrap{height:430px}}</style></head><body><div class="w">
<header class="top"><div class="brand">NEXFORGE<small>HOST ROOT</small></div><div class="actions"><a class="btn" href=".">Servers</a><button class="btn" id="logout2">Déconnexion</button></div></header>
<section class="hero"><div class="k">Direct VPS host control</div><h1>Root<br><span class="a">Terminal.</span></h1><p class="m">Accès hôte réel : TTY interactif, /etc, systemd, Docker, réseau, processus et fichiers.</p></section>
<div class="hostgrid"><aside class="sidepanel"><div class="hosthead"><div class="k">Hosts</div><button class="btn" id="reloadHosts">↻</button></div><div id="hosts"></div>
<hr style="border:0;border-top:1px solid var(--l);margin:18px 0">
<div class="k">Connexion SSH directe</div><p class="m">NexForge se connecte une seule fois en SSH pour installer l’agent. Le mot de passe n’est ni enregistré ni renvoyé au navigateur.</p>
<input id="sshHost" value="31.56.85.53" placeholder="IP / hostname">
<div class="prompt"><input id="sshUser" value="root" placeholder="Utilisateur"><input id="sshPort" value="22" inputmode="numeric" style="max-width:92px"></div>
<input id="sshPassword" type="password" autocomplete="new-password" placeholder="Mot de passe root" style="margin-top:8px">
<button class="btn pri" id="bootstrapSsh" style="width:100%;margin-top:8px">Connecter et installer</button>
<div id="sshStatus" class="m" style="margin-top:10px;white-space:pre-wrap"></div>
<hr style="border:0;border-top:1px solid var(--l);margin:18px 0">
<div class="k">Installation manuelle</div><p class="m">Alternative : génère une commande d’installation à usage unique et exécute-la toi-même en root.</p><button class="btn" id="setupHost">Générer la commande</button><div id="installCmd" class="install" style="display:none;margin-top:10px"></div></aside>
<main class="mainpanel"><div class="hosthead"><div><div class="k">Selected host</div><div class="v" id="hostName">Aucun</div></div><div id="hostState" class="m"></div></div>
<div class="tabs"><button class="btn htab on" data-pane="ttyPane">Interactive TTY</button><button class="btn htab" data-pane="cmdPane">Command</button><button class="btn htab" data-pane="filePane">Files</button><button class="btn htab" data-pane="opsPane">System</button></div>
<section id="ttyPane" class="hpane"><div class="actions" style="margin-bottom:10px"><button class="btn pri" id="openTty">Open root TTY</button><button class="btn" id="closeTty">Close</button></div><div class="xtermwrap" id="terminal"></div><p class="m" id="ttyStatus">Sélectionne un hôte en ligne.</p></section>
<section id="cmdPane" class="hpane hide"><pre class="term" id="hostOut">NexForge root command shell ready.\\n</pre><div class="prompt"><input id="hostCmd" placeholder="root@host:~#"><button class="btn pri" id="hostRun">Run</button></div></section>
<section id="filePane" class="hpane hide"><div class="bar"><input id="hostPath" value="/" placeholder="/"><button class="btn" id="hostList">List</button><button class="btn" id="up">Up</button></div><div class="grid"><div class="c c4"><div class="files" id="hostFiles"></div></div><div class="c c8"><input id="hostFilePath" placeholder="/etc/..." style="margin-bottom:8px"><textarea id="hostEditor"></textarea><div class="actions"><button class="btn pri" id="hostSave">Save + backup</button><button class="btn" id="hostReloadFile">Reload</button></div><p class="m" id="hostFileStatus"></p></div></div></section>
<section id="opsPane" class="hpane hide"><div class="quick"><button class="btn" data-op="system.info">System info</button><button class="btn" data-op="process.list">Processes</button><button class="btn" data-op="disk.usage">Disk</button><button class="btn" data-op="net.info">Network</button></div><div class="bar"><input id="service" placeholder="nginx.service"><select id="svcAction"><option>status</option><option>restart</option><option>start</option><option>stop</option><option>reload</option><option>enable</option><option>disable</option></select><button class="btn" id="svcGo">systemd</button></div><div class="bar"><input id="container" placeholder="container name/id"><select id="dockerAction"><option>ps</option><option>logs</option><option>restart</option><option>start</option><option>stop</option><option>kill</option></select><button class="btn" id="dockerGo">Docker</button></div><pre class="term" id="opsOut">System operations output.\\n</pre></section>
</main></div></div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script><script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script><script>
const $=x=>document.getElementById(x);let hs=[],host=null,ws=null,term=null,fit=null;
async function api(a,o){o=o||{};const r=await fetch("?api="+a,{...o,headers:{"content-type":"application/json",...(o.headers||{})}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j}
async function loadHosts(){const j=await api("host-agents");hs=j.agents||[];$("hosts").innerHTML=hs.map(h=>{const on=Date.now()-new Date(h.last_seen_at||0).getTime()<30000;return "<div class='hostitem "+(host&&host.id===h.id?"sel":"")+"' data-id='"+h.id+"'><b>"+(h.name||h.hostname||"Host")+"</b><br><span class='m'><span class='dot "+(on?"ok":"")+"'></span>"+(on?"online":"offline")+" · "+(h.arch||"")+"</span></div>"}).join("")||"<p class='m'>Aucun agent hôte installé.</p>";document.querySelectorAll(".hostitem").forEach(e=>e.onclick=()=>selectHost(e.dataset.id));if(!host&&hs.length)selectHost(hs[0].id)}
function selectHost(id){host=hs.find(x=>x.id===id);loadHosts();if(!host)return;$("hostName").textContent=host.name||host.hostname||"Host";const on=Date.now()-new Date(host.last_seen_at||0).getTime()<30000;$("hostState").textContent=(on?"ONLINE":"OFFLINE")+" · "+(host.hostname||"")+" · "+(host.kernel||"");}
async function hjob(kind,payload){if(!host)throw new Error("Select a host");const q=await api("host-job-create",{method:"POST",body:JSON.stringify({agentId:host.id,kind,payload:payload||{}})});for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,500));const s=await api("host-job-status&id="+encodeURIComponent(q.id)),j=s.job;if(j&&j.status==="done")return j.result;if(j&&j.status==="failed")throw new Error(j.error||"Job failed")}throw new Error("Timeout")}
async function rootCmd(){const c=$("hostCmd").value.trim();if(!c)return;$("hostCmd").value="";$("hostOut").textContent+="\\n# "+c+"\\n";try{const r=await hjob("exec",{command:c,cwd:"/",timeout:90});$("hostOut").textContent+=(r.stdout||"")+(r.stderr||"")+"\\n[exit "+r.code+"]\\n"}catch(e){$("hostOut").textContent+="[error] "+e.message+"\\n"}$("hostOut").scrollTop=$("hostOut").scrollHeight}
async function setup(){const j=await api("host-setup",{method:"POST",body:"{}"});const url=location.origin+location.pathname+"?api=host-install&setup="+encodeURIComponent(j.token);const cmd="curl -fsSL '"+url+"' | sudo bash";$("installCmd").style.display="block";$("installCmd").textContent=cmd+"\\n\\nExpire : "+new Date(j.expires_at).toLocaleString()}
async function bootstrapSshUi(){
  const b=$("bootstrapSsh"),st=$("sshStatus");
  const hostValue=$("sshHost").value.trim();
  b.disabled=true; st.textContent="Connexion SSH et lancement de l’installation…";
  try{
    const r=await api("host-bootstrap-ssh",{method:"POST",body:JSON.stringify({
      host:hostValue,port:Number($("sshPort").value||22),username:$("sshUser").value.trim()||"root",password:$("sshPassword").value
    })});
    $("sshPassword").value="";
    st.textContent="✓ Connexion SSH réussie ("+(r.username||"utilisateur SSH")+"). Installation terminée.\\n"+(r.output||"")+"\\nAttente du premier heartbeat NexForge…";
    const started=Date.now();
    while(Date.now()-started<180000){
      await new Promise(x=>setTimeout(x,5000));
      await loadHosts();
      const recent=hs.find(x=>Date.now()-new Date(x.last_seen_at||0).getTime()<30000 && (x.hostname||"").length);
      if(recent){
        selectHost(recent.id);
        st.textContent="✓ VPS connecté à NexForge : "+(recent.hostname||recent.name||hostValue);
        return;
      }
    }
    st.textContent="L’installation SSH a été lancée, mais aucun heartbeat n’a encore été reçu. Ouvre la liste Hosts dans quelques instants.";
  }catch(e){
    st.textContent="Erreur : "+e.message;
  }finally{b.disabled=false}
}
async function openTty(){if(!host)return;try{if(ws)ws.close();const r=await hjob("pty.ticket",{}),url=r.tunnel_url.replace(/^https:/,"wss:")+"/ws?ticket="+encodeURIComponent(r.ticket);if(!term){term=new Terminal({cursorBlink:true,fontSize:13,convertEol:true,scrollback:5000,theme:{background:"#030405"}});fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open($("terminal"));fit.fit();window.addEventListener("resize",()=>{fit.fit();sendResize()});term.onData(d=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:"input",data:d}))})}else term.clear();$("ttyStatus").textContent="Connecting…";ws=new WebSocket(url);ws.binaryType="arraybuffer";ws.onopen=()=>{$("ttyStatus").textContent="ROOT TTY CONNECTED";sendResize()};ws.onmessage=e=>{if(typeof e.data==="string")term.write(e.data);else term.write(new Uint8Array(e.data))};ws.onerror=()=>{$("ttyStatus").textContent="TTY error"};ws.onclose=()=>{$("ttyStatus").textContent="TTY disconnected"}}catch(e){$("ttyStatus").textContent=e.message}}
function sendResize(){if(ws&&ws.readyState===1&&term)ws.send(JSON.stringify({type:"resize",cols:term.cols,rows:term.rows}))}
async function listFiles(){try{const r=await hjob("fs.list",{path:$("hostPath").value||"/"}),items=r.items||[];$("hostFiles").innerHTML=items.map(x=>"<div class='file' data-p='"+encodeURIComponent(x.path)+"' data-d='"+(x.type==="directory")+"'>"+(x.type==="directory"?"▸ ":"· ")+x.name+" <span class='m'>"+(x.mode||"")+"</span></div>").join("");document.querySelectorAll("#hostFiles .file").forEach(e=>e.onclick=()=>openFile(decodeURIComponent(e.dataset.p),e.dataset.d==="true"))}catch(e){$("hostFiles").textContent=e.message}}
async function openFile(p,d){if(d){$("hostPath").value=p;return listFiles()}$("hostFilePath").value=p;return readFile()}
async function readFile(){const p=$("hostFilePath").value.trim();if(!p)return;try{const r=await hjob("fs.read",{path:p});if(r.binary){$("hostEditor").value="";$("hostFileStatus").textContent="Binary file · "+r.size+" bytes"}else{$("hostEditor").value=r.content||"";$("hostFileStatus").textContent="Loaded "+p}}catch(e){$("hostFileStatus").textContent=e.message}}
async function saveFile(){const p=$("hostFilePath").value.trim();if(!p)return;try{const r=await hjob("fs.write",{path:p,content:$("hostEditor").value});$("hostFileStatus").textContent="Saved · backup "+(r.backup||"none")}catch(e){$("hostFileStatus").textContent=e.message}}
async function op(kind,payload){$("opsOut").textContent="Running "+kind+"…\\n";try{const r=await hjob(kind,payload||{});$("opsOut").textContent=JSON.stringify(r,null,2)}catch(e){$("opsOut").textContent=e.message}}
document.querySelectorAll(".htab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".htab").forEach(x=>x.classList.remove("on"));document.querySelectorAll(".hpane").forEach(x=>x.classList.add("hide"));b.classList.add("on");$(b.dataset.pane).classList.remove("hide");if(b.dataset.pane==="ttyPane"&&fit)setTimeout(()=>fit.fit(),50)});
$("reloadHosts").onclick=loadHosts;$("bootstrapSsh").onclick=bootstrapSshUi;$("setupHost").onclick=setup;$("hostRun").onclick=rootCmd;$("hostCmd").onkeydown=e=>{if(e.key==="Enter")rootCmd()};$("openTty").onclick=openTty;$("closeTty").onclick=()=>{if(ws)ws.close()};$("hostList").onclick=listFiles;$("up").onclick=()=>{const p=$("hostPath").value||"/";const parts=p.split("/").filter(Boolean);parts.pop();$("hostPath").value=parts.length?"/"+parts.join("/"):"/";listFiles()};$("hostReloadFile").onclick=readFile;$("hostSave").onclick=saveFile;document.querySelectorAll("[data-op]").forEach(b=>b.onclick=()=>op(b.dataset.op,{}));$("svcGo").onclick=()=>op("systemd",{action:$("svcAction").value,service:$("service").value});$("dockerGo").onclick=()=>op("docker",{action:$("dockerAction").value,target:$("container").value});$("logout2").onclick=async()=>{await api("logout",{method:"POST",body:"{}"}).catch(()=>{});location.href="."};
loadHosts();setInterval(loadHosts,15000);
</script></body></html>`);
}

const CSS = `
:root{--bg:#07080b;--p:#101219;--p2:#151824;--t:#f5f7fb;--m:#8d95a7;--l:#292e3e;--a:#c8b9ff;--g:#7ef0b0;--r:#ff9b9b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#1b1532 0,transparent 35%),var(--bg);color:var(--t);font:14px Inter,system-ui,sans-serif}button,input,select,textarea{font:inherit}.w{max-width:1500px;margin:auto;padding:20px}.top{display:flex;justify-content:space-between;align-items:center;padding:8px 0 24px}.brand{font-weight:900;font-size:20px;letter-spacing:-.05em}.brand small{color:var(--a);font-size:9px;letter-spacing:.13em;margin-left:7px}.hero{border-top:1px solid var(--l);padding:30px 0}.hero h1{font-size:clamp(60px,9vw,135px);line-height:.78;letter-spacing:-.08em;text-transform:uppercase;margin:0}.a{color:var(--a)}.m{color:var(--m)}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}.c{grid-column:span 3;border:1px solid var(--l);background:#101219dd;border-radius:22px;padding:18px}.c8{grid-column:span 8}.c4{grid-column:span 4}.c12{grid-column:span 12}.k{font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--m)}.v{font-size:30px;font-weight:800;margin-top:12px}.btn{border:1px solid var(--l);background:#151824;color:var(--t);border-radius:999px;padding:10px 14px;cursor:pointer}.pri{background:var(--a);color:#111;border-color:var(--a)}.danger{color:#ffb5b5;border-color:#613434}.actions,.tabs{display:flex;gap:8px;flex-wrap:wrap}.tabs{margin:18px 0}.tab.on{background:var(--a);color:#111}.hide{display:none}input,select,textarea{width:100%;background:#090b10;color:var(--t);border:1px solid var(--l);border-radius:12px;padding:11px;outline:none}.bar{display:grid;grid-template-columns:1.2fr 1fr auto;gap:8px;margin:12px 0}.term{background:#030405;border:1px solid #222737;border-radius:16px;padding:14px;min-height:360px;max-height:520px;overflow:auto;white-space:pre-wrap;font:12px/1.55 ui-monospace,monospace;color:#d9ffe7}.prompt{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:9px}.files{border:1px solid var(--l);border-radius:14px;max-height:350px;overflow:auto}.file{padding:10px;border-bottom:1px solid var(--l);cursor:pointer}.file:hover{background:#171b27}textarea{min-height:310px;font:12px ui-monospace,monospace}.login{min-height:100vh;display:grid;place-items:center;padding:20px}.box{width:min(450px,100%);border:1px solid var(--l);border-radius:26px;background:#0d0f16;padding:30px}.box h1{font-size:56px;line-height:.85;letter-spacing:-.07em;text-transform:uppercase}.box input{margin:16px 0 10px}.box .btn{width:100%}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--r);margin-right:6px}.dot.ok{background:var(--g)}
@media(max-width:950px){.c,.c8,.c4{grid-column:span 12}.bar{grid-template-columns:1fr}.hero h1{font-size:18vw}.w{padding:14px}}
`;

function loginPage(message = "") {
  return html(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NexForge Servers</title><style>${CSS}</style></head><body><main class="login"><section class="box"><div class="brand">NEXFORGE<small>SERVERS</small></div><div class="k">Private server control</div><h1>Server<br><span class="a">Access.</span></h1><p class="m">Utilise le même mot de passe administrateur que NexControl.</p><form method="post"><input type="hidden" name="action" value="login"><input type="password" name="password" placeholder="Mot de passe NexControl" required autofocus><button class="btn pri">Ouvrir la console →</button><p class="m">${message}</p></form></section></main></body></html>`);
}

function appPage() {
  return html(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NexForge Servers</title><style>${CSS}</style></head><body><div class="w"><header class="top"><div class="brand">NEXFORGE<small>SERVERS</small></div><div class="actions"><a class="btn" href="?host=1">Host root</a><button class="btn" id="logout">Déconnexion</button></div></header><section class="hero"><div class="k">Nextech infrastructure</div><h1>Server<br><span class="a">Control.</span></h1><p class="m">Terminal, fichiers, logs et alimentation du serveur depuis le navigateur.</p></section>
<section class="grid"><div class="c"><div class="k">Server</div><div class="v" id="state">—</div></div><div class="c"><div class="k">CPU</div><div class="v" id="cpu">—</div></div><div class="c"><div class="k">RAM</div><div class="v" id="ram">—</div></div><div class="c"><div class="k">Disk</div><div class="v" id="disk">—</div></div><div class="c c12"><div class="k">Power</div><div class="actions" style="margin-top:12px"><button class="btn pri" data-p="start">Start</button><button class="btn" data-p="restart">Restart</button><button class="btn" data-p="stop">Stop</button><button class="btn danger" data-p="kill">Kill</button></div></div></section>
<div class="tabs"><button class="btn tab on" data-tab="shell">Shell</button><button class="btn tab" data-tab="console">Console live</button><button class="btn tab" data-tab="files">Files</button></div>
<section id="shell" class="grid pane"><div class="c c8"><div class="k">Command terminal</div><div class="bar"><select id="agent"></select><select id="root"></select><button class="btn" id="refresh">Refresh</button></div><pre class="term" id="term">NexForge shell ready.\n</pre><div class="prompt"><input id="cmd" placeholder="Commande shell…" autocomplete="off"><button class="btn pri" id="run">Run</button></div></div><div class="c c4"><div class="k">Agent</div><div class="v" id="astate">—</div><p class="m" id="ameta"></p><div class="actions"><button class="btn" id="sys">System info</button><button class="btn" id="ps">Processes</button><button class="btn" id="du">Disk usage</button></div></div></section>
<section id="console" class="grid pane hide"><div class="c c12"><div class="k">Pterodactyl WebSocket</div><div class="actions" style="margin:12px 0"><button class="btn pri" id="connect">Connect</button><button class="btn" id="clear">Clear</button></div><pre class="term" id="live">Console disconnected.\n</pre></div></section>
<section id="files" class="grid pane hide"><div class="c c4"><div class="k">File browser</div><div class="prompt"><input id="path" value="."><button class="btn" id="list">List</button></div><div class="files" id="filelist" style="margin-top:10px"></div></div><div class="c c8"><div class="k">Editor</div><input id="filePath" placeholder="Path" style="margin:10px 0"><textarea id="editor"></textarea><div class="actions"><button class="btn pri" id="save">Save</button><button class="btn" id="reload">Reload</button></div><p class="m" id="fstatus"></p></div></section>
</div><script>
const $=x=>document.getElementById(x);let agents=[],active=null,ws=null,hist=[],hi=0;
async function api(a,o){o=o||{};const r=await fetch("?api="+a,{...o,headers:{"content-type":"application/json",...(o.headers||{})}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j}
function t(s){$("term").textContent+=s;$("term").scrollTop=$("term").scrollHeight}
function l(s){$("live").textContent+=s;$("live").scrollTop=$("live").scrollHeight}
async function status(){try{const j=await api("status"),a=j.attributes||j.data&&j.data.attributes||{},r=a.resources||{};$("state").textContent=String(a.current_state||"unknown").toUpperCase();$("cpu").textContent=Number(r.cpu_absolute||0).toFixed(1)+"%";$("ram").textContent=Math.round(Number(r.memory_bytes||0)/1048576)+" MB";$("disk").textContent=Math.round(Number(r.disk_bytes||0)/1048576)+" MB"}catch(e){$("state").textContent="OFFLINE"}}
async function loadAgents(){const j=await api("agents");agents=j.agents||[];$("agent").innerHTML=agents.map(a=>"<option value='"+a.id+"'>"+a.display_name+"</option>").join("");if(agents.length){active=agents.find(a=>a.slug==="nexus-main")||agents[0];$("agent").value=active.id;sync()}}
function sync(){active=agents.find(a=>a.id===$("agent").value);if(!active)return;const on=Date.now()-new Date(active.last_heartbeat_at||0).getTime()<120000;$("astate").innerHTML="<span class='dot "+(on?"ok":"")+"'></span>"+(on?"ONLINE":"OFFLINE");$("ameta").textContent=(active.hostname||"")+" · "+(active.platform||"")+" · "+(active.node_version||"");$("root").innerHTML=(active.roots||[]).map(r=>"<option value='"+r.key+"'>"+r.key+" — "+r.path+"</option>").join("")}
async function job(kind,payload){if(!active)throw new Error("No agent");const q=await api("job-create",{method:"POST",body:JSON.stringify({agentId:active.id,kind,payload})});for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,800));const s=await api("job-status&id="+encodeURIComponent(q.id)),j=s.job;if(j&&j.status==="done")return j.result;if(j&&j.status==="failed")throw new Error(j.error||"Job failed")}throw new Error("Timeout")}
async function run(){const c=$("cmd").value.trim();if(!c)return;$("cmd").value="";hist.push(c);hi=hist.length;t("\n$ "+c+"\n");try{const r=await job("runtime.exec",{root:$("root").value,shell:c});if(r&&r.stdout)t(r.stdout);if(r&&r.stderr)t(r.stderr);t("\n[exit "+(r&&r.code!=null?r.code:"?")+"]\n")}catch(e){t("[error] "+e.message+"\n")}}
async function gen(k){t("\n["+k+"]\n");try{t(JSON.stringify(await job(k,{root:$("root").value}),null,2)+"\n")}catch(e){t("[error] "+e.message+"\n")}}
async function list(){try{const r=await job("fs.list",{root:$("root").value,path:$("path").value||"."}),items=r.entries||r.files||r.items||[];$("filelist").innerHTML=items.map(x=>{const n=x.name||x.path||"",d=x.type==="directory"||x.isDirectory===true||x.dir===true;return "<div class='file' data-n='"+encodeURIComponent(n)+"' data-d='"+d+"'>"+(d?"▸ ":"· ")+n+"</div>"}).join("")||"<div class='file m'>No files</div>";document.querySelectorAll(".file[data-n]").forEach(e=>e.onclick=()=>openEntry(decodeURIComponent(e.dataset.n),e.dataset.d==="true"))}catch(e){$("filelist").textContent=e.message}}
async function openEntry(n,d){const b=$("path").value||".",p=(b==="."?"":b.replace(/\/$/,"")+"/")+n;if(d){$("path").value=p;return list()}$("filePath").value=p;loadFile()}
async function loadFile(){const p=$("filePath").value.trim();if(!p)return;try{const r=await job("fs.read",{root:$("root").value,path:p});$("editor").value=r.content||r.text||"";$("fstatus").textContent="Loaded "+p}catch(e){$("fstatus").textContent=e.message}}
async function save(){const p=$("filePath").value.trim();if(!p)return;try{const r=await job("fs.write",{root:$("root").value,path:p,content:$("editor").value});$("fstatus").textContent="Saved"+(r&&r.backupId?" · backup "+r.backupId:"")}catch(e){$("fstatus").textContent=e.message}}
async function connect(){if(ws)try{ws.close()}catch{};try{const j=await api("console-token");$("live").textContent="Connecting…\n";ws=new WebSocket(j.data&&j.data.socket||j.socket);const tok=j.data&&j.data.token||j.token;ws.onopen=()=>ws.send(JSON.stringify({event:"auth",args:[tok]}));ws.onmessage=e=>{try{const q=JSON.parse(e.data),a=Array.isArray(q.args)?q.args:[];if(q.event==="auth success"){l("[authenticated]\n");ws.send(JSON.stringify({event:"send logs",args:[null]}));ws.send(JSON.stringify({event:"send stats",args:[null]}))}else if(q.event==="console output")l(String(a[0]||"")+"\n");else if(q.event==="status")l("[status] "+String(a[0]||"")+"\n")}catch{l(String(e.data)+"\n")}};ws.onerror=()=>l("[websocket error]\n");ws.onclose=()=>l("[disconnected]\n")}catch(e){l("[error] "+e.message+"\n")}}
document.querySelectorAll("[data-p]").forEach(b=>b.onclick=async()=>{try{await api("power",{method:"POST",body:JSON.stringify({signal:b.dataset.p})});setTimeout(status,1200)}catch(e){alert(e.message)}});document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("on"));document.querySelectorAll(".pane").forEach(x=>x.classList.add("hide"));b.classList.add("on");$(b.dataset.tab).classList.remove("hide")});
$("agent").onchange=sync;$("refresh").onclick=loadAgents;$("run").onclick=run;$("cmd").onkeydown=e=>{if(e.key==="Enter")run();else if(e.key==="ArrowUp"){e.preventDefault();if(hist.length){hi=Math.max(0,hi-1);$("cmd").value=hist[hi]||""}}};$("sys").onclick=()=>gen("system.info");$("ps").onclick=()=>gen("process.list");$("du").onclick=()=>gen("disk.usage");$("list").onclick=list;$("reload").onclick=loadFile;$("save").onclick=save;$("connect").onclick=connect;$("clear").onclick=()=>$("live").textContent="";$("logout").onclick=async()=>{await api("logout",{method:"POST",body:"{}"}).catch(()=>{});location.reload()};
Promise.allSettled([status(),loadAgents()]);setInterval(status,15000);
</script></body></html>`);
}



/* NEXFORGE_MCP_V1
 * Shared MCP control plane for Claude + ChatGPT.
 * Authentication is capability-token based; only token hashes live in Postgres.
 */
const NEXFORGE_MCP_V1 = "1.0.0";

const NXF_MCP_TOOLS = [
  {
    name: "nexforge_status",
    description: "Read the shared NexForge state: workers, tasks, active resource locks, NexControl agents, and host agents.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "list_workers",
    description: "List ChatGPT, Claude, and other workers registered in the shared NexForge workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "list_tasks",
    description: "List shared NexForge tasks. Check this before starting work so you do not duplicate another worker's work.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        project: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "create_task",
    description: "Create a durable NexForge task. Use executor 'shared' when either Claude or ChatGPT may claim it.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        project: { type: "string" },
        executor: { type: "string", enum: ["claude","chatgpt","shared","any"] },
        priority: { type: "integer", minimum: 0, maximum: 4 },
        payload: { type: "object" }
      },
      additionalProperties: false
    }
  },
  {
    name: "claim_task",
    description: "Atomically claim a task with a lease. Claim before changing a shared project. If task_id is omitted, claim the best available task for this worker/shared.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        lease_seconds: { type: "integer", minimum: 60, maximum: 3600 }
      },
      additionalProperties: false
    }
  },
  {
    name: "heartbeat_task",
    description: "Refresh a task lease and publish progress while working.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string" },
        progress: { type: "integer", minimum: 0, maximum: 100 },
        last_action: { type: "string" },
        next_action: { type: "string" },
        lease_seconds: { type: "integer", minimum: 60, maximum: 3600 }
      },
      additionalProperties: false
    }
  },
  {
    name: "complete_task",
    description: "Complete a claimed task, save the result, and release locks associated with it.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string" },
        result: { type: "object" }
      },
      additionalProperties: false
    }
  },
  {
    name: "release_task",
    description: "Return a claimed task to the queue without completing it.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string" },
        reason: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "list_locks",
    description: "List active exclusive resource locks. Check them before modifying shared files, repositories, services, deployments, bots, or servers.",
    inputSchema: {
      type: "object",
      properties: { prefix: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "lock_resource",
    description: "Acquire or refresh an exclusive lease on a resource, for example repo:Nexus-tech-01/NexTelegrambots:path:nexcontrol or server:primary:service:nexai.",
    inputSchema: {
      type: "object",
      required: ["resource_key"],
      properties: {
        resource_key: { type: "string", minLength: 1 },
        task_id: { type: "string" },
        lease_seconds: { type: "integer", minimum: 60, maximum: 3600 },
        metadata: { type: "object" }
      },
      additionalProperties: false
    }
  },
  {
    name: "unlock_resource",
    description: "Release a resource lock owned by the current worker.",
    inputSchema: {
      type: "object",
      required: ["resource_key"],
      properties: { resource_key: { type: "string", minLength: 1 } },
      additionalProperties: false
    }
  },
  {
    name: "list_infrastructure_agents",
    description: "List NexControl runtime agents and NexForge host agents without exposing their secret keys.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "run_host_job",
    description: "Queue an operation on a NexForge host agent. Mutating operations should be protected by a task lease and resource lock.",
    inputSchema: {
      type: "object",
      required: ["kind"],
      properties: {
        agent_id: { type: "string" },
        kind: {
          type: "string",
          enum: ["exec","fs.list","fs.read","fs.write","fs.mkdir","fs.move","fs.copy","fs.delete","fs.chmod","system.info","process.list","disk.usage","net.info","systemd","docker","pty.ticket"]
        },
        payload: { type: "object" }
      },
      additionalProperties: false
    }
  },
  {
    name: "host_job_status",
    description: "Read the state and result of a NexForge host job.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" } },
      additionalProperties: false
    }
  }
];

function nxfMcpText(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

function nxfMcpRpcOk(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function nxfMcpRpcErr(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function nxfMcpLimit(value, fallback = 50, max = 100) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.trunc(n))) : fallback;
}

function nxfMcpRow(data) {
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

async function nxfMcpAuth(req, u) {
  let raw = (u.searchParams.get("access") || "").trim();
  if (!raw) {
    const h = req.headers.get("authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m) raw = m[1].trim();
  }
  if (!raw) return null;

  const tokenHash = await sha(raw);
  const { data, error } = await sb
    .from("nxf_mcp_tokens")
    .select("id,worker_slug,scopes,active,expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error || !data || !data.active) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return null;

  const worker = String(data.worker_slug);
  const scopes = Array.isArray(data.scopes) ? data.scopes.map(String) : [];
  const now = new Date().toISOString();

  await Promise.allSettled([
    sb.from("nxf_mcp_tokens").update({ last_used_at: now }).eq("id", data.id),
    sb.from("nxf_workers").upsert({
      slug: worker,
      display_name: worker === "claude" ? "Claude" : worker === "chatgpt" ? "ChatGPT" : worker,
      provider: worker === "claude" ? "anthropic" : worker === "chatgpt" ? "openai" : "external",
      status: "online",
      capabilities: { mcp: true, coordination: true, nexcontrol: true },
      last_seen_at: now,
      updated_at: now
    }, { onConflict: "slug" })
  ]);

  return { worker, scopes, tokenId: String(data.id) };
}

function nxfMcpRequire(ctx, scope) {
  if (!ctx.scopes.includes(scope) && !ctx.scopes.includes("*")) {
    throw new Error("scope_denied:" + scope);
  }
}

async function nxfMcpTool(ctx, name, a) {
  if (name === "nexforge_status") {
    nxfMcpRequire(ctx, "tasks:read");
    const now = new Date().toISOString();
    const [workers, tasks, locks, agents, hosts] = await Promise.all([
      sb.from("nxf_workers").select("slug,display_name,provider,status,last_seen_at").order("slug"),
      sb.from("nxc_task_queue").select("status"),
      sb.from("nxf_resource_locks").select("resource_key,worker,task_id,lease_expires_at,metadata").gt("lease_expires_at", now).order("resource_key"),
      sb.from("nxc_agents").select("id,slug,display_name,hostname,last_heartbeat_at,enabled").eq("enabled", true).order("display_name"),
      sb.from("nxc_host_agents").select("id,name,hostname,version,last_seen_at,enabled").eq("enabled", true).order("name")
    ]);
    const counts = {};
    for (const t of (tasks.data || [])) counts[String(t.status)] = (counts[String(t.status)] || 0) + 1;
    return {
      workspace: "NexForge",
      version: NEXFORGE_MCP_V1,
      current_worker: ctx.worker,
      task_counts: counts,
      workers: workers.data || [],
      active_locks: locks.data || [],
      nexcontrol_agents: agents.data || [],
      host_agents: hosts.data || [],
      server_time: now
    };
  }

  if (name === "list_workers") {
    nxfMcpRequire(ctx, "tasks:read");
    const { data, error } = await sb.from("nxf_workers")
      .select("slug,display_name,provider,status,capabilities,last_seen_at,updated_at")
      .order("slug");
    if (error) throw error;
    return data || [];
  }

  if (name === "list_tasks") {
    nxfMcpRequire(ctx, "tasks:read");
    let q = sb.from("nxc_task_queue")
      .select("id,external_ref,title,description,project,executor,priority,status,progress,worker,locked_at,lease_expires_at,last_action,next_action,blocked_reason,result,created_by,created_at,updated_at")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(nxfMcpLimit(a.limit));
    if (a.status) q = q.eq("status", String(a.status));
    if (a.project) q = q.eq("project", String(a.project));
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  if (name === "create_task") {
    nxfMcpRequire(ctx, "tasks:write");
    const executor = ["claude","chatgpt","shared","any"].includes(String(a.executor || "")) ? String(a.executor) : ctx.worker;
    const { data, error } = await sb.from("nxc_task_queue").insert({
      title: String(a.title || "").trim(),
      description: String(a.description || ""),
      project: String(a.project || "general"),
      executor,
      priority: Math.max(0, Math.min(4, Number(a.priority ?? 2))),
      payload: (a.payload && typeof a.payload === "object") ? a.payload : {},
      created_by: ctx.worker,
      status: "pending",
      progress: 0
    }).select("id,title,project,executor,priority,status,created_at").single();
    if (error) throw error;
    await sb.from("nxc_task_events").insert({
      task_id: data.id,
      event_type: "created",
      worker: ctx.worker,
      message: "Task created through NexForge MCP",
      data: {}
    });
    return data;
  }

  if (name === "claim_task") {
    nxfMcpRequire(ctx, "tasks:write");
    const { data, error } = await sb.rpc("nxf_claim_task", {
      p_worker: ctx.worker,
      p_task_id: a.task_id ? String(a.task_id) : null,
      p_lease_seconds: Math.max(60, Math.min(3600, Number(a.lease_seconds ?? 600)))
    });
    if (error) throw error;
    const row = nxfMcpRow(data);
    return row?.id ? { claimed: true, task: row } : { claimed: false };
  }

  if (name === "heartbeat_task") {
    nxfMcpRequire(ctx, "tasks:write");
    const { data, error } = await sb.rpc("nxf_touch_task", {
      p_worker: ctx.worker,
      p_task_id: String(a.task_id),
      p_progress: a.progress == null ? null : Number(a.progress),
      p_last_action: a.last_action == null ? null : String(a.last_action),
      p_next_action: a.next_action == null ? null : String(a.next_action),
      p_lease_seconds: Math.max(60, Math.min(3600, Number(a.lease_seconds ?? 600)))
    });
    if (error) throw error;
    const row = nxfMcpRow(data);
    if (!row?.id) throw new Error("task_not_owned_or_not_in_progress");
    return row;
  }

  if (name === "complete_task") {
    nxfMcpRequire(ctx, "tasks:write");
    const { data, error } = await sb.rpc("nxf_finish_task", {
      p_worker: ctx.worker,
      p_task_id: String(a.task_id),
      p_result: (a.result && typeof a.result === "object") ? a.result : {}
    });
    if (error) throw error;
    const row = nxfMcpRow(data);
    if (!row?.id) throw new Error("task_not_owned_or_not_in_progress");
    return row;
  }

  if (name === "release_task") {
    nxfMcpRequire(ctx, "tasks:write");
    const { data, error } = await sb.rpc("nxf_release_task", {
      p_worker: ctx.worker,
      p_task_id: String(a.task_id),
      p_reason: a.reason == null ? null : String(a.reason)
    });
    if (error) throw error;
    const row = nxfMcpRow(data);
    if (!row?.id) throw new Error("task_not_owned_or_not_in_progress");
    return row;
  }

  if (name === "list_locks") {
    nxfMcpRequire(ctx, "locks");
    let q = sb.from("nxf_resource_locks")
      .select("resource_key,worker,task_id,lease_expires_at,metadata,updated_at")
      .gt("lease_expires_at", new Date().toISOString())
      .order("resource_key");
    if (a.prefix) q = q.like("resource_key", String(a.prefix) + "%");
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  if (name === "lock_resource") {
    nxfMcpRequire(ctx, "locks");
    const { data, error } = await sb.rpc("nxf_acquire_lock", {
      p_worker: ctx.worker,
      p_resource_key: String(a.resource_key),
      p_task_id: a.task_id ? String(a.task_id) : null,
      p_lease_seconds: Math.max(60, Math.min(3600, Number(a.lease_seconds ?? 600))),
      p_metadata: (a.metadata && typeof a.metadata === "object") ? a.metadata : {}
    });
    if (error) throw error;
    return { acquired: Boolean(data), resource_key: String(a.resource_key), worker: ctx.worker };
  }

  if (name === "unlock_resource") {
    nxfMcpRequire(ctx, "locks");
    const { data, error } = await sb.rpc("nxf_release_lock", {
      p_worker: ctx.worker,
      p_resource_key: String(a.resource_key)
    });
    if (error) throw error;
    return { released: Boolean(data), resource_key: String(a.resource_key) };
  }

  if (name === "list_infrastructure_agents") {
    nxfMcpRequire(ctx, "infra:read");
    const [nxc, host] = await Promise.all([
      sb.from("nxc_agents").select("id,slug,display_name,hostname,platform,node_version,last_heartbeat_at,roots,capabilities,enabled").order("display_name"),
      sb.from("nxc_host_agents").select("id,name,hostname,os,kernel,arch,version,capabilities,enabled,last_seen_at").order("name")
    ]);
    if (nxc.error) throw nxc.error;
    if (host.error) throw host.error;
    return { nexcontrol_agents: nxc.data || [], host_agents: host.data || [] };
  }

  if (name === "run_host_job") {
    nxfMcpRequire(ctx, "infra:write");
    const allowed = new Set(["exec","fs.list","fs.read","fs.write","fs.mkdir","fs.move","fs.copy","fs.delete","fs.chmod","system.info","process.list","disk.usage","net.info","systemd","docker","pty.ticket"]);
    const kind = String(a.kind || "");
    if (!allowed.has(kind)) throw new Error("unsupported_host_job_kind");

    let agentId = a.agent_id ? String(a.agent_id) : "";
    if (!agentId) {
      const { data, error } = await sb.from("nxc_host_agents")
        .select("id")
        .eq("enabled", true)
        .order("last_seen_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data?.id) throw new Error("no_enabled_host_agent");
      agentId = String(data.id);
    }

    const { data, error } = await sb.from("nxc_host_jobs").insert({
      agent_id: agentId,
      kind,
      payload: (a.payload && typeof a.payload === "object") ? a.payload : {},
      status: "pending"
    }).select("id,agent_id,kind,status,created_at").single();
    if (error) throw error;
    return data;
  }

  if (name === "host_job_status") {
    nxfMcpRequire(ctx, "infra:read");
    const { data, error } = await sb.from("nxc_host_jobs")
      .select("id,agent_id,kind,status,result,error,claimed_at,claim_expires_at,completed_at,created_at,updated_at")
      .eq("id", String(a.job_id))
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("host_job_not_found");
    return data;
  }

  throw new Error("unknown_tool:" + name);
}

async function nxfMcpMessage(ctx, msg) {
  const id = msg?.id ?? null;
  const method = String(msg?.method || "");

  if (method === "initialize") {
    const requested = String(msg?.params?.protocolVersion || "2025-06-18");
    return nxfMcpRpcOk(id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "NexForge",
        title: "NexForge Multi-Agent Control Plane",
        version: NEXFORGE_MCP_V1
      },
      instructions: "You are connected to the owner's shared NexForge workspace. Before changing shared infrastructure: inspect tasks and locks, claim or create a task, lock the resources you will mutate, keep leases alive, save code changes to Git, deploy through NexControl/NexForge when required, verify the result, then complete the task and release locks. Coordinate with ChatGPT instead of editing the same resource concurrently."
    });
  }

  if (method === "ping") return nxfMcpRpcOk(id, {});
  if (method === "tools/list") return nxfMcpRpcOk(id, { tools: NXF_MCP_TOOLS });

  if (method === "tools/call") {
    const name = String(msg?.params?.name || "");
    const args = msg?.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
    try {
      return nxfMcpRpcOk(id, nxfMcpText(await nxfMcpTool(ctx, name, args)));
    } catch (e) {
      return nxfMcpRpcOk(id, nxfMcpText({ error: String(e?.message || e) }, true));
    }
  }

  if (method.startsWith("notifications/")) return null;
  return nxfMcpRpcErr(id, -32601, "Method not found", { method });
}

async function handleNexForgeMcp(req, u) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization,content-type,mcp-protocol-version,mcp-session-id",
        "access-control-allow-methods": "GET,POST,HEAD,OPTIONS",
        "cache-control": "no-store"
      }
    });
  }

  const ctx = await nxfMcpAuth(req, u);
  if (!ctx) {
    return json(
      { error: "unauthorized", hint: "Use the private NexForge connector URL or a valid Bearer capability token." },
      401,
      { "www-authenticate": 'Bearer realm="NexForge"' }
    );
  }

  if (req.method === "HEAD") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

  if (req.method === "GET") {
    return json({
      ok: true,
      service: "NexForge MCP",
      version: NEXFORGE_MCP_V1,
      transport: "streamable-http",
      worker: ctx.worker,
      tools: NXF_MCP_TOOLS.map(t => t.name)
    });
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "GET,POST,HEAD,OPTIONS" });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(nxfMcpRpcErr(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(body)) {
    const out = [];
    for (const msg of body) {
      const result = await nxfMcpMessage(ctx, msg);
      if (result) out.push(result);
    }
    return out.length ? json(out) : new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  }

  const result = await nxfMcpMessage(ctx, body);
  return result ? json(result) : new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
}

Deno.serve(async req => {
  try {
    const u = new URL(req.url);
    if (u.searchParams.get("mcp") === "1") return await handleNexForgeMcp(req, u);
    const api = u.searchParams.get("api");
    if (!api && req.method === "GET" && req.headers.get("x-nexforge-proxy") !== "1") {
      const hostQuery = u.searchParams.get("host") === "1" ? "?host=1" : "";
      return new Response(null, {
        status: 302,
        headers: {
          "location": "https://knowme-secret-git-nexforge-preview-tresorhtn-1071s-projects.vercel.app/nexforge" + hostQuery,
          "cache-control": "no-store"
        }
      });
    }
    if (req.method === "POST" && !api) {
      const q = await readBody(req);
      if (q.action === "login") {
        const raw = await doLogin(String(q.password || ""));
        if (!raw) return loginPage("Mot de passe incorrect.");
        return new Response(null, { status: 303, headers: { "location": u.pathname + (u.searchParams.get("host")==="1" ? "?host=1" : ""), "set-cookie": "nxc_session=" + encodeURIComponent(raw) + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + SESSION_SECONDS } });
      }
    }
    if (api === "host-install") {
      const setup = u.searchParams.get("setup") || "";
      if (!await validHostSetup(setup)) return new Response("Invalid or expired setup token", { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      return new Response(hostInstallScript(setup), { status: 200, headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" } });
    }
    if (!api && u.searchParams.get("host") === "1") return await admin(req) ? hostPage() : loginPage("");
    if (!api) return await admin(req) ? appPage() : loginPage("");
    if (api === "logout") {
      await doLogout(req);
      return json({ ok: true }, 200, { "set-cookie": "nxc_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
    }
    if (!await admin(req)) return json({ error: "unauthorized" }, 401);
    if (api === "host-setup" && req.method === "POST") return json(await hostSetupToken());
    if (api === "host-bootstrap-ssh" && req.method === "POST") {
      const q = await readBody(req);
      return json(await bootstrapHostSsh(String(q.host||""), Number(q.port||22), String(q.username||"root"), String(q.password||"")));
    }
    if (api === "host-agents") return json({ agents: await hostAgentsList() });
    if (api === "host-job-create" && req.method === "POST") {
      const q = await readBody(req);
      return json(await makeHostJob(String(q.agentId || ""), String(q.kind || ""), q.payload || {}));
    }
    if (api === "host-job-status") {
      const id = u.searchParams.get("id") || "";
      return json({ job: await hostJobStatus(id) });
    }
    if (api === "agents") return json({ agents: await agents() });
    if (api === "status") return json(await ptero("/api/client/servers/:id/resources"));
    if (api === "console-token") return json(await ptero("/api/client/servers/:id/websocket"));
    if (api === "power" && req.method === "POST") {
      const q = await readBody(req);
      const signal = String(q.signal || "");
      if (!["start","restart","stop","kill"].includes(signal)) return json({ error: "invalid_signal" }, 400);
      await ptero("/api/client/servers/:id/power", { method: "POST", body: JSON.stringify({ signal }) });
      return json({ ok: true });
    }
    if (api === "job-create" && req.method === "POST") {
      const q = await readBody(req);
      return json(await makeJob(String(q.agentId || ""), String(q.kind || ""), q.payload || {}));
    }
    if (api === "job-status") {
      const id = u.searchParams.get("id") || "";
      const { data, error } = await sb.from("nxc_agent_jobs").select("id,kind,status,result,error,created_at,completed_at").eq("id", id).maybeSingle();
      if (error) throw error;
      return json({ job: data });
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
});
