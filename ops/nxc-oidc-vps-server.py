#!/usr/bin/env python3
"""NexControl: keyless GitHub Actions OIDC administrative endpoint.

No static GitHub token on VPS. The GitHub-hosted workflow asks GitHub to sign
an ephemeral OIDC JWT bound to the SHA256 of the exact request body. Verify
RSA signature, issuer, audience, repository ID, workflow path, git ref and
event type before performing a root operation. Replay is denied in SQLite.
"""
import base64
import datetime
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import ssl
import subprocess
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

from cryptography.hazmat.primitives.asymmetric import rsa,padding
from cryptography.hazmat.primitives import hashes

REPO="Tresor562/Nexus-lab"
REPO_ID="1327705715"
WORKFLOW="Tresor562/Nexus-lab/.github/workflows/nxc-vps-commands.yml@refs/heads/main"
ISSUER="https://token.actions.githubusercontent.com"
PORT=18473
HOME=Path("/var/lib/nxc-oidc-vps")
CERT=Path("/etc/letsencrypt/live/nxc.31-56-85-53.sslip.io/fullchain.pem")
KEY=Path("/etc/letsencrypt/live/nxc.31-56-85-53.sslip.io/privkey.pem")
JWKS_URL=ISSUER+"/.well-known/jwks"
LOG=logging.getLogger("nxc-oidc")
_CACHE={"until":0,"keys":[]}
LOCK=Lock()
SENSITIVE=re.compile(r"(?im)((?:password|token|api.key|secret|private.key)\s*[=:]\s*)\S+")
GH_TOKEN=re.compile(r"github_pat_[a-zA-Z0-9_]{15,}|gh[pousr]_[A-Za-z0-9_]{15,}")

def b64url(text):
    return base64.urlsafe_b64decode(text + "="*((-len(text))%4))

def verify_oidc(jwt, body):
    if not isinstance(jwt,str) or len(jwt)>9000 or len(jwt)<350:
        raise ValueError("invalid_identity")
    parts=jwt.split(".")
    if len(parts)!=3: raise ValueError("invalid_jwt")
    try:
        h=json.loads(b64url(parts[0]))
        payload=json.loads(b64url(parts[1]))
        sig=b64url(parts[2])
    except Exception: raise ValueError("invalid_jwt_encoding") from None
    if h.get("alg")!="RS256" or not isinstance(h.get("kid"),str):
        raise ValueError("jwt_algorithm")
    now=int(time.time())
    if now>_CACHE["until"]:
        req=urllib.request.Request(JWKS_URL,headers={"User-Agent":"NexControlOIDC/1"})
        with urllib.request.urlopen(req,timeout=8) as r:
            data=json.load(r)
        keys=data.get("keys",[])
        if not isinstance(keys,list) or len(keys)>30: raise ValueError("invalid_jwks")
        _CACHE["keys"]=keys; _CACHE["until"]=now+300
    jwk=next((k for k in _CACHE["keys"] if k.get("kid")==h["kid"] and k.get("kty")=="RSA"),None)
    if not jwk:
        _CACHE["until"]=0
        raise ValueError("unknown_signing_key")
    n=int.from_bytes(b64url(jwk["n"]),"big");e=int.from_bytes(b64url(jwk["e"]),"big")
    pub=rsa.RSAPublicNumbers(e,n).public_key()
    try:
        pub.verify(sig,(parts[0]+"."+parts[1]).encode("ascii"),padding.PKCS1v15(),hashes.SHA256())
    except Exception:
        raise ValueError("invalid_signature") from None
    expected_aud="nxc-vps:"+hashlib.sha256(body).hexdigest()
    for name,val in [
        ("iss",ISSUER),
        ("aud",expected_aud),
        ("repository",REPO),
        ("repository_id",REPO_ID),
        ("workflow_ref",WORKFLOW),
        ("ref","refs/heads/main"),
        ("event_name","issues"),
    ]:
        if payload.get(name)!=val:
            raise ValueError("invalid_oidc_claim_"+name)
    if payload.get("actor_id")!="232972883":
        raise ValueError("untrusted_actor")
    try:
        iat=int(payload["iat"]);nbf=int(payload.get("nbf",iat));exp=int(payload["exp"])
    except (ValueError,TypeError,KeyError):
        raise ValueError("invalid_oidc_time") from None
    if not (iat-45<=now<=exp and nbf-45<=now and exp-iat<=600):
        raise ValueError("expired_identity")
    return hashlib.sha256(jwt.encode()).hexdigest(),exp

def db():
    HOME.mkdir(parents=True,exist_ok=True,mode=0o700)
    conn=sqlite3.connect(str(HOME/"audit.sqlite3"),timeout=12,isolation_level=None)
    conn.execute("CREATE TABLE IF NOT EXISTS operations("
                 "token_hash TEXT PRIMARY KEY, issue INTEGER NOT NULL, "
                 "created INT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL)")
    return conn

def scrub(text):
    text=SENSITIVE.sub(r"\1[redacted]",str(text))
    text=GH_TOKEN.sub("[redacted-github-token]",text)
    return text[:9500]

def execute(argv,timeout=50):
    env={"PATH":"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
         "HOME":"/root","LANG":"C.UTF-8"}
    proc=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
       text=True,errors="replace",start_new_session=True,cwd="/",env=env)
    try:
        out,_=proc.communicate(timeout=min(100,max(1,int(timeout))))
        return {"ok":proc.returncode==0,"exitCode":proc.returncode,"output":scrub(out)}
    except subprocess.TimeoutExpired:
        try: os.killpg(proc.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        proc.communicate()
        return {"ok":False,"exitCode":124,"output":"Command exceeded time limit"}

def perform(command):
    action=command.get("action")
    p=command.get("params") or {}
    if not isinstance(p,dict): raise ValueError("invalid_params")
    if action=="ping":
        return {"ok":True,"service":"nxc-oidc-vps","hostname":socket.gethostname(),"timestamp":int(time.time())}
    if action=="system":
        disk=os.statvfs("/")
        return {"ok":True,"hostname":socket.gethostname(),"diskFree":disk.f_bavail*disk.f_frsize,
                "uptimeSec":int(float(Path("/proc/uptime").read_text().split()[0]))}
    if action in ("service_status","service_restart","service_logs"):
        unit=p.get("service")
        if not isinstance(unit,str) or not re.fullmatch(r"[A-Za-z0-9_.@-]{1,128}",unit):
            raise ValueError("invalid_service")
        if action=="service_status":return execute(["systemctl","status","--no-pager","--lines=20",unit])
        if action=="service_restart":return execute(["systemctl","restart",unit],60)
        count=max(1,min(150,int(p.get("lines",50))))
        return execute(["journalctl","-u",unit,"-n",str(count),"--no-pager"])
    if action=="shell":
        cmd=p.get("command")
        if not isinstance(cmd,str) or not cmd.strip() or len(cmd)>4500:
            raise ValueError("invalid_command")
        return execute(["/bin/bash","-lc",cmd],p.get("timeout",70))
    raise ValueError("unsupported_action")

class Handler(BaseHTTPRequestHandler):
    server_version="NexControlOIDC/1"
    def log_message(self,fmt,*args):
        LOG.info("%s %s",self.address_string(),scrub(fmt%args))
    def answer(self,status,body):
        raw=json.dumps(body,ensure_ascii=False,separators=(",",":")).encode()
        self.send_response(status)
        self.send_header("Content-Type","application/json")
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Content-Length",str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        if self.path=="/healthz":
            return self.answer(200,{"ok":True,"service":"nxc-oidc-vps","authenticated":False})
        self.answer(404,{"ok":False,"error":"not_found"})
    def do_POST(self):
        if self.path!="/v1/operate":return self.answer(404,{"ok":False,"error":"not_found"})
        try:
            size=int(self.headers.get("Content-Length") or 0)
            if size<20 or size>6500: raise ValueError("invalid_body_size")
            body=self.rfile.read(size)
            if len(body)!=size: raise ValueError("truncated_body")
            h=self.headers.get("Authorization","")
            if not h.startswith("Bearer "): raise ValueError("missing_identity")
            token_hash,expiry=verify_oidc(h[7:],body)
            request=json.loads(body)
            if set(request)!={"v","issue","command","author"} or request["v"]!=1:
                raise ValueError("invalid_request")
            if request["author"]!=232972883: raise ValueError("untrusted_request_author")
            issue=request["issue"]
            if not isinstance(issue,int) or issue<=0:raise ValueError("invalid_issue")
            operation=request["command"]
            if not isinstance(operation,dict):raise ValueError("invalid_command")
            # Authorization is tied to exact body hash; store a durable, unique JWT
            # hash BEFORE execution so no network retry can repeat shell/root ops.
            with LOCK:
                c=db()
                try:
                    c.execute("INSERT INTO operations VALUES(?,?,?,?,?)",
                       (token_hash,issue,int(time.time()),str(operation.get("action"))[:80],"started"))
                except sqlite3.IntegrityError:
                    return self.answer(409,{"ok":False,"error":"replay_denied"})
                finally:
                    c.close()
            try:
                result=perform(operation)
                state="done" if result.get("ok") else "failed"
            except Exception as exc:
                state="failed"
                result={"ok":False,"error":scrub(str(exc))}
            with LOCK:
                c=db()
                c.execute("UPDATE operations SET state=? WHERE token_hash=?",(state,token_hash))
                c.close()
            return self.answer(200,result)
        except Exception as exc:
            LOG.warning("Rejected request: %s",scrub(str(exc)))
            return self.answer(401,{"ok":False,"error":"authentication_or_request_rejected"})

def main():
    logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(message)s")
    if not CERT.is_file() or not KEY.is_file():
        raise SystemExit("NexControl TLS certificate absent: cannot launch secure admin bridge")
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version=ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(str(CERT),str(KEY))
    server=ThreadingHTTPServer(("0.0.0.0",PORT),Handler)
    server.daemon_threads=True
    server.socket=ctx.wrap_socket(server.socket,server_side=True)
    LOG.info("NexControl keyless GitHub OIDC admin bridge ready on port %d",PORT)
    server.serve_forever(poll_interval=0.5)

if __name__=="__main__":
    main()
