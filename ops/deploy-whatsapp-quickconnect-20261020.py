#!/usr/bin/env python3
"""Install reviewed WhatsApp owner-only direct pairing without replacing live bot logic.

Source assets are pinned to commit 796f03e8 (PR #183).
Keeps credentials/queue/data untouched; always backups live server before edits.
"""
from pathlib import Path
import datetime
import os
import shutil
import stat
import subprocess
import time
import urllib.request
import urllib.error

COMMIT = "796f03e8af8801e9acc6d12808849af22518186f"
BASE = "https://raw.githubusercontent.com/Nexus-tech-01/NexTelegrambots/" + COMMIT + "/whatsapp-publisher/"
ROOT = Path("/opt/nex/apps/internal/whatsapp-publisher/current")
SERVER = ROOT / "server.mjs"
UNIT = "nex-whatsapp-publisher.service"
MARKER = "NEX_WA_QUICK_CONNECT_OCT2026"
ASSETS = ("quick-connect.html", "quick-connect-guard.mjs")

def cmd(*args, timeout=25, check=True):
    return subprocess.run(args, check=check, timeout=timeout,
                          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def fetch(name):
    with urllib.request.urlopen(BASE + name, timeout=20) as res:
        data = res.read(130_000)
    if not data or len(data) >= 130_000:
        raise RuntimeError("Invalid asset size: " + name)
    data.decode("utf-8")
    return data

def patch(text):
    if MARKER in text:
        print("ALREADY_PATCHED=1")
        return text

    def one(original, replacement):
        nonlocal text
        if text.count(original) != 1:
            raise RuntimeError("Unexpected live server revision: " + original[:65])
        text = text.replace(original, replacement, 1)

    one("import http from 'node:http';",
        "import http from 'node:http';\n"
        "import {normalizePhone,phoneFromWhatsAppCredentials,isSameOriginPairingRequest,isAuthorizedWhatsAppPhone} "
        "from './quick-connect-guard.mjs'; // " + MARKER)

    one("const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');",
        "const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');\n"
        "const OWNER_PHONE = normalizePhone(process.env.NEX_WHATSAPP_OWNER_PHONE || process.env.WHATSAPP_OWNER_PHONE || '');")

    one("function json(res, status, obj, headers={}) {",
        """function approvedWhatsAppPhone(){
  if(OWNER_PHONE) return OWNER_PHONE;
  try{
    const c=JSON.parse(fs.readFileSync(path.join(AUTH_DIR,'creds.json'),'utf8'));
    return phoneFromWhatsAppCredentials(c);
  }catch{return '';}
}
function directPairOriginAllowed(req){
  return isSameOriginPairingRequest(req.headers.origin,req.headers.host) &&
    String(req.headers['content-type']||'').includes('application/json');
}
function json(res, status, obj, headers={}) {""")

    one(
       "    if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/app')) {",
       """    if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/connect')){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
        'x-content-type-options':'nosniff',
        'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'"});
      return res.end(fs.readFileSync(new URL('./quick-connect.html',import.meta.url),'utf8'));
    }
    if(req.method==='GET'&&url.pathname==='/api/quick-connect/status'){
      return json(res,200,{status:state.status==='connected'?'connected':'disconnected'});
    }
    if(req.method==='POST'&&url.pathname==='/api/quick-connect/pair'){
      if(!directPairOriginAllowed(req)) return json(res,403,{error:'Requête refusée.'});
      const approved=approvedWhatsAppPhone();
      if(!approved) return json(res,503,{error:'Numéro WhatsApp administrateur non enregistré sur le serveur.'});
      const data=await body(req);
      const requested=normalizePhone(data.phone);
      if(!isAuthorizedWhatsAppPhone(requested,approved))
        return json(res,403,{error:'Ce numéro ne correspond pas au compte WhatsApp autorisé.'});
      if(state.status==='connected') return json(res,409,{error:'WhatsApp est déjà connecté.'});
      const pairing=await requestPairingCode(requested);
      return json(res,200,{ok:true,formatted:pairing.formatted,code:pairing.raw});
    }
    if(req.method==='GET'&&url.pathname==='/app') {""")
    return text

def http_status(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as res:
            return res.status, res.read(150_000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, ''
    except Exception:
        return 0, ''

def validate():
    active=cmd("systemctl","is-active",UNIT,check=False).stdout.strip()
    health,_=http_status("http://127.0.0.1:8787/healthz")
    page,html=http_status("http://127.0.0.1:8787/")
    status,api=http_status("http://127.0.0.1:8787/api/quick-connect/status")
    secure,_=http_status("http://127.0.0.1:8787/api/status")
    print("SERVICE="+active+" HEALTH="+str(health)+" ROOT="+str(page)+" DIRECT_STATUS="+str(status)+" ADMIN_GUARD="+str(secure))
    return active=="active" and health==200 and page==200 and "Connecter WhatsApp" in html and status==200 and secure==401

def main():
    if not SERVER.is_file():
        raise RuntimeError("Expected live WhatsApp server not found")
    source=SERVER.read_text()
    changed=MARKER not in source
    edited=patch(source)
    downloads={name:fetch(name) for name in ASSETS}
    backups=Path("/var/backups") / ("nexai-wa-direct-pair-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backups.mkdir(mode=0o700)
    existing={}
    for file in ("server.mjs",)+ASSETS:
        dest=ROOT/file
        existing[file]=dest.is_file()
        if existing[file]:
            shutil.copy2(dest, backups/file)
    print("BACKUP_READY=1")
    try:
        for name,blob in downloads.items():
            dest=ROOT/name
            tmp=ROOT/(name+".new")
            tmp.write_bytes(blob); os.chmod(tmp,0o644); os.replace(tmp,dest)
        tmp=ROOT/"server.directpair-check.mjs"
        original_stat = SERVER.stat()
        tmp.write_text(edited)
        # The service runs as a non-root user. Atomic replace must preserve
        # read permissions and ownership from the live entrypoint.
        os.chmod(tmp, stat.S_IMODE(original_stat.st_mode))
        os.chown(tmp, original_stat.st_uid, original_stat.st_gid)
        cmd("node","--check",str(tmp),timeout=15)
        tmp.replace(SERVER)
        cmd("systemctl","restart",UNIT,timeout=40)
        ok=False
        for _ in range(8):
            time.sleep(2)
            if validate():
                ok=True
                break
        if not ok:
            raise RuntimeError("Publisher failed post-deploy health/security gate")
        print("DEPLOYED=1")
        print("PASSWORDLESS_PAIRING_PAGE=1")
        print("PRESERVED_LIVE_PUBLISHER_PATCHES=1")
        print("PRESERVED_WA_SESSION_AND_QUEUES=1")
        print("LIVE_CHANGE="+str(changed))
        status,html=http_status("https://dream-overcome-mapping-twins.trycloudflare.com/")
        print("PUBLIC_TUNNEL_HTTP="+str(status)+" PUBLIC_PASSWORDLESS_PAGE="+str(status==200 and "Connecter WhatsApp" in html))
    except Exception:
        print("ROLLBACK_REQUIRED=1")
        for file in ("server.mjs",)+ASSETS:
            dest=ROOT/file
            if existing[file]:
                shutil.copy2(backups/file,dest)
            else:
                dest.unlink(missing_ok=True)
        cmd("systemctl","restart",UNIT,timeout=40,check=False)
        print("ROLLBACK_RESTORED=1")
        raise

if __name__=="__main__":
    main()
