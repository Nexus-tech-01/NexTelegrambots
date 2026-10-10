#!/usr/bin/env python3
"""NexControl outbound GitHub issue bridge. NO inbound HTTP server.

Requests: GitHub private issue authored by pinned account:
Title: [NXC/VPS] operation name
Body: NXC-OP-V1 newline JSON: {"v":1,"action":"ping","params":{}}
Only the user-authorized private repo may deliver root operations.
"""
import datetime
import json
import logging
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

REPO = "Tresor562/Nexus-lab"
AUTHOR_ID = 232972883
AUTHOR = "tresor562"
STATE = Path("/var/lib/nxc-github-bridge")
MAX_OUTPUT = 6500
PROTECTED = re.compile(r"(?i)(/etc/shadow|/root/\.ssh/|/etc/nxc-vps/|/root/\.config/|/var/lib/nxc-github-bridge/|/\.env(?:$|[./]))")
REDACT = [
    (re.compile(r"(?i)(bearer\s+)[a-z0-9._=-]{15,}"), r"\1[redacted]"),
    (re.compile(r"(?i)((?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)\s*[=:]\s*)\S+"), r"\1[redacted]"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}"), "[redacted token]"),
]

def clean(s):
    s = str(s)
    for p, r in REDACT:
        s = p.sub(r, s)
    return s[:MAX_OUTPUT]

def api(method, route, token, body=None):
    url = "https://api.github.com" + route
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "NexControlPrivateBridge/1.0",
        **({"Content-Type": "application/json"} if data is not None else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read(300000))
    except urllib.error.HTTPError as e:
        raise RuntimeError("GitHub HTTP " + str(e.code) + " on " + method + " " + route.split("?")[0]) from None

def parse(issue, installed_at):
    if issue.get("pull_request"):
        return None
    u = issue.get("user") or {}
    if u.get("id") != AUTHOR_ID or str(u.get("login", "")).lower() != AUTHOR:
        return None
    if not str(issue.get("title", "")).startswith("[NXC/VPS] "):
        return None
    body = issue.get("body") or ""
    if len(body) > 8000 or not body.startswith("NXC-OP-V1\n"):
        return None
    try:
        p = json.loads(body[len("NXC-OP-V1\n"):])
        created = datetime.datetime.fromisoformat(issue["created_at"].replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, KeyError):
        return None
    if not isinstance(p, dict) or p.get("v") != 1:
        return None
    if set(p) - {"v", "action", "params", "note"}:
        return None
    if not isinstance(p.get("params", {}), dict):
        return None
    if p.get("action") not in {"ping","system","service_status","service_restart","service_logs","shell","read_file","write_file"}:
        return None
    if created < installed_at - 5 or time.time() - created > 21600:
        return None
    return p

def database():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    c = sqlite3.connect(str(STATE / "state.sqlite"), timeout=15)
    c.execute("CREATE TABLE IF NOT EXISTS jobs(issue INTEGER PRIMARY KEY, state TEXT, updated INT)")
    c.commit()
    return c

def reserve(c, number):
    try:
        c.execute("INSERT INTO jobs VALUES (?,?,?)", (number, "running", int(time.time())))
        c.commit()
        return True
    except sqlite3.IntegrityError:
        return False

def execute(argv, timeout=45):
    env = {"HOME": "/root", "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
    try:
        r = subprocess.run(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=max(1, min(120, int(timeout))), cwd="/root", env=env, errors="replace")
        return {"ok":r.returncode == 0, "exit_code":r.returncode, "output":clean(r.stdout)}
    except subprocess.TimeoutExpired:
        return {"ok":False, "exit_code":124, "output":"Timed out"}

def filename(p):
    if not isinstance(p, str) or not p.startswith("/") or len(p) > 500:
        raise ValueError("Absolute file path required")
    path = Path(p).resolve(strict=False)
    if PROTECTED.search(str(path)):
        raise ValueError("Secret path blocked")
    return path

def run(action, p):
    if action == "ping":
        return {"ok":True, "server":socket.gethostname(), "bridge":"nxc-github-v1"}
    if action == "system":
        d = os.statvfs("/")
        return {"ok":True,"server":socket.gethostname(),
            "uptime_seconds":int(float(Path("/proc/uptime").read_text().split()[0])),
            "free_disk_bytes":d.f_bavail*d.f_frsize}
    if action.startswith("service_"):
        service = p.get("service")
        if not isinstance(service, str) or not re.fullmatch(r"[A-Za-z0-9_.@-]{1,100}", service):
            raise ValueError("Invalid service name")
        if action == "service_status":
            return execute(["systemctl","status","--no-pager","--lines=15",service])
        if action == "service_restart":
            return execute(["systemctl","restart",service],50)
        return execute(["journalctl","-u",service,"--no-pager","-n",str(min(150,max(1,int(p.get("lines",60)))))])
    if action == "shell":
        cmd = p.get("command")
        if not isinstance(cmd, str) or not cmd.strip() or len(cmd) > 4000:
            raise ValueError("Invalid shell command")
        return execute(["/bin/bash","-lc",cmd], p.get("timeout",60))
    if action == "read_file":
        path = filename(p.get("path"))
        if not path.is_file() or path.stat().st_size > MAX_OUTPUT:
            raise ValueError("Missing or oversized file")
        return {"ok":True, "path":str(path), "content":clean(path.read_text(errors="replace"))}
    if action == "write_file":
        path = filename(p.get("path"))
        if not str(path).startswith(("/opt/nxc-vps/","/etc/nginx/conf.d/","/etc/nginx/sites-enabled/","/tmp/")):
            raise ValueError("Write tool restricted to gateway/Nginx/tmp; shell requires explicit ticket")
        contents = p.get("content")
        if not isinstance(contents, str) or len(contents.encode()) > 4000:
            raise ValueError("Invalid file data")
        path.parent.mkdir(parents=True, exist_ok=True)
        backup = None
        if path.exists():
            if not path.is_file(): raise ValueError("Refusing non-file replacement")
            backup = str(path) + ".nxc-backup-" + str(int(time.time()))
            shutil.copy2(path, backup)
        pending = Path(str(path)+".nxc-pending")
        pending.write_text(contents)
        pending.chmod(0o600)
        os.replace(pending,path)
        return {"ok":True,"path":str(path),"backup":backup}
    raise ValueError("Unsupported operation")

def one_tick(cfg, token, c):
    issues = api("GET","/repos/"+REPO+"/issues?state=open&per_page=60&sort=created&direction=desc",token)
    if not isinstance(issues, list):
        raise RuntimeError("Invalid issue API response")
    for issue in reversed(issues):
        ticket = parse(issue, cfg["installed_at"])
        if ticket is None:
            continue
        number = int(issue["number"])
        if not reserve(c,number):
            continue
        state = "failed"
        try:
            answer = run(ticket["action"],ticket.get("params",{}))
            state = "done" if answer["ok"] else "failed"
            message = ("SUCCESS" if state == "done" else "FAILED") + " NXC BRIDGE V1\n"
            message += "action="+ticket["action"]+"\n"
            message += json.dumps(answer,ensure_ascii=False,indent=2)[:MAX_OUTPUT]
        except Exception as e:
            message = "FAILED NXC BRIDGE V1\n" + clean(str(e))
        try:
            api("POST","/repos/"+REPO+"/issues/"+str(number)+"/comments",token,{"body":message})
            c.execute("UPDATE jobs SET state=?,updated=? WHERE issue=?",(state,int(time.time()),number))
        except Exception as e:
            # Never retry an operation after uncertain results, especially restart/shell.
            logging.error("Issue #%s result posting failed: %s",number,clean(e))
            c.execute("UPDATE jobs SET state=?,updated=? WHERE issue=?",("reply_failed",int(time.time()),number))
        c.commit()
        return True
    return False

def main():
    logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(message)s")
    cfg=json.loads(Path("/etc/nxc-github-bridge/config.json").read_text())
    if cfg.get("repo")!=REPO or cfg.get("trusted_author_id")!=AUTHOR_ID:
        raise RuntimeError("Control repository/author integrity check failed")
    token=Path("/etc/nxc-github-bridge/github-token").read_text().strip()
    if len(token)<25 or "\n" in token:
        raise RuntimeError("Missing private GitHub token")
    meta=api("GET","/repos/"+REPO,token)
    if meta.get("private") is not True or meta.get("full_name")!=REPO:
        raise RuntimeError("Private repository required; refusing to enable root commands")
    c=database()
    logging.info("NexControl outbound bridge active; private GitHub issue queue only")
    errors=0
    while True:
        try:
            one_tick(cfg,token,c)
            errors=0
            time.sleep(12)
        except KeyboardInterrupt:
            raise
        except Exception as e:
            errors=min(errors+1,6)
            logging.warning("Bridge polling error: %s",clean(e))
            time.sleep(errors*12)

if __name__=="__main__":
    main()
