#!/usr/bin/env python3
"""NexControl VPS local control plane. No Supabase or Vercel runtime dependency."""
import hashlib, hmac, html, json, os, re, secrets, shlex, shutil, sqlite3
import subprocess, sys, threading, time, pwd, grp
from collections import defaultdict, deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HOME = Path("/var/lib/nxc-vps")
IDENTITY_V3 = Path("/var/lib/nexcontrol-identity/accounts.sqlite3")
CONFIG_PATH = Path("/etc/nxc-vps/config.json")
CONFIG = json.loads(CONFIG_PATH.read_text())
DOMAIN = CONFIG["domain"]
ORIGIN = "https://" + DOMAIN
DB = HOME / "gateway.sqlite3"
PAIR_CLI = "/opt/nex/apps/public/nexai/current/cli.mjs"
HOST_ENV = Path("/etc/nexforge-host-agent.env")
AGENT_SLUGS = {"nexus-main", "nexus-ptero-primary", "nexus-failover-a", "nexus-failover-b", "nexus-watchdog"}
LOCK = threading.Lock()
COUNTERS = defaultdict(deque)
PAIR_SLOTS = threading.BoundedSemaphore(8)

def connection():
    d = sqlite3.connect(str(DB), timeout=10, isolation_level=None)
    d.row_factory = sqlite3.Row
    d.execute("PRAGMA journal_mode=WAL")
    d.execute("PRAGMA busy_timeout=10000")
    return d

def initialize():
    HOME.mkdir(parents=True, exist_ok=True)
    with connection() as d:
        d.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL, kind TEXT NOT NULL,
          created INTEGER NOT NULL, last_seen INTEGER NOT NULL,
          last_ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',
          revoked INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS devices_active ON devices(revoked,last_seen);
        CREATE TABLE IF NOT EXISTS agents (
          slug TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, details TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL,
          claimed INTEGER, result TEXT, error TEXT);
        CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(slug,status,created);
        CREATE TABLE IF NOT EXISTS host_jobs (
          id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL,
          claimed INTEGER, completed INTEGER, result TEXT, error TEXT);
        CREATE INDEX IF NOT EXISTS host_jobs_claim ON host_jobs(agent_id,status,created);
        CREATE TABLE IF NOT EXISTS assistant_keys (
          id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
          created INTEGER NOT NULL, expires INTEGER NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0, last_used INTEGER);
        CREATE INDEX IF NOT EXISTS assistant_keys_expiry ON assistant_keys(expires);
        CREATE TABLE IF NOT EXISTS host_agents (
          id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, details TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL,
          action TEXT NOT NULL, detail TEXT NOT NULL);
        """)
    os.chmod(DB, 0o600)
    # Existing gateway databases predate role-scoped assistant keys.
    with connection() as d:
        columns={row["name"] for row in d.execute("PRAGMA table_info(assistant_keys)")}
        if "role" not in columns:
            d.execute("ALTER TABLE assistant_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'observer'")
        session_cols={row["name"] for row in d.execute("PRAGMA table_info(sessions)")}
        if "device_id" not in session_cols:
            d.execute("ALTER TABLE sessions ADD COLUMN device_id TEXT")
        d.execute("CREATE INDEX IF NOT EXISTS sessions_device_id ON sessions(device_id)")

def audit(action, detail=""):
    with connection() as d:
        d.execute("INSERT INTO audit(created,action,detail) VALUES (?,?,?)",
                  (int(time.time()), action[:80], str(detail)[:350]))

def allowed(ip, kind, limit, window=60):
    now = time.monotonic()
    with LOCK:
        q = COUNTERS[(ip, kind)]
        while q and now-q[0] > window: q.popleft()
        if len(q) >= limit: return False
        q.append(now)
        if len(COUNTERS) > 20000:
            for k in list(COUNTERS)[:5000]:
                if not COUNTERS[k] or now-COUNTERS[k][-1]>window: COUNTERS.pop(k, None)
    return True

def validate_password(password):
    if not isinstance(password, str) or len(password)>256: return False
    v = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(CONFIG["salt"]), 260000)
    return hmac.compare_digest(v.hex(), CONFIG["password_hash"])

def host_auth(p):
    if not HOST_ENV.exists(): return False
    vals = {}
    for line in HOST_ENV.read_text().splitlines():
        if "=" not in line: continue
        key, value = line.split("=",1)
        if key not in ("AGENT_ID","AGENT_KEY"): continue
        try:
            x = shlex.split(value)
            vals[key] = x[0] if x else ""
        except ValueError: continue
    return bool(vals.get("AGENT_ID") and vals.get("AGENT_KEY") and
       hmac.compare_digest(str(p.get("p_agent_id") or ""), vals["AGENT_ID"]) and
       hmac.compare_digest(str(p.get("p_agent_key") or ""), vals["AGENT_KEY"]))

def account_audit_snapshot():
    """Read-only owner dashboard view; never return token hashes or credentials."""
    if not IDENTITY_V3.is_file():
        return {"ready":False,"accounts":[],"events":[],"devices":0,"sessions":0}
    c=sqlite3.connect("file:"+str(IDENTITY_V3)+"?mode=ro",uri=True,timeout=6)
    c.row_factory=sqlite3.Row
    try:
        accounts=[dict(r) for r in c.execute(
            "SELECT username,kind,role,status FROM principals ORDER BY username LIMIT 200"
        ).fetchall()]
        events=[dict(r) for r in c.execute("""
            SELECT e.timestamp,COALESCE(p.username,'service') actor,e.channel,e.action,
                   e.outcome,e.reason,e.correlation_id
              FROM events e LEFT JOIN principals p ON e.actor=p.id
             ORDER BY e.timestamp DESC,e.id DESC LIMIT 60
        """).fetchall()]
        devices=c.execute("SELECT count(*) FROM devices WHERE revoked=0").fetchone()[0]
        sessions=c.execute("SELECT count(*) FROM sessions WHERE revoked=0 AND expires>?",(int(time.time()),)).fetchone()[0]
        return {"ready":True,"accounts":accounts,"events":events,"devices":devices,"sessions":sessions}
    finally:
        c.close()

def access_inventory():
    """Enumerate visible access paths. Authenticated admin route only.

    Metadata, not secrets. Cloud provider consoles, external IAM and delegated
    credentials outside this host cannot be enumerated here.
    """
    now=int(time.time())
    accounts=[]
    try:
        sudo_members=set(grp.getgrnam("sudo").gr_mem)
    except KeyError:
        sudo_members=set()
    try:
        docker_members=set(grp.getgrnam("docker").gr_mem)
    except KeyError:
        docker_members=set()
    for u in pwd.getpwall():
        if u.pw_uid!=0 and not (1000<=u.pw_uid<65534):
            continue
        auth=Path(u.pw_dir) / ".ssh" / "authorized_keys"
        count=0
        if auth.is_file() and not auth.is_symlink():
            try:
                count=sum(1 for line in auth.read_text(errors="replace").splitlines()
                          if line.strip() and not line.lstrip().startswith("#"))
            except (PermissionError,OSError):
                count=-1
        accounts.append({"username":u.pw_name,"uid":u.pw_uid,
            "sudoMember":u.pw_uid==0 or u.pw_name in sudo_members,
            "dockerMember":u.pw_name in docker_members,
            "shell":u.pw_shell,"authorizedKeyEntries":count})
    accounts.sort(key=lambda item:(item["uid"],item["username"]))

    def rows(path,query,args=()):
        if not path.is_file(): return []
        c=sqlite3.connect("file:"+str(path)+"?mode=ro",uri=True,timeout=5)
        c.row_factory=sqlite3.Row
        try: return [dict(r) for r in c.execute(query,args).fetchall()]
        finally:c.close()

    mobile=rows(Path("/var/lib/nexcontrol-mobile/access.sqlite3"),
      "SELECT k.id,k.label,k.scopes,k.created,k.expires,s.last AS lastSeen "
      "FROM keys k LEFT JOIN seen s ON s.id=k.id ORDER BY k.created DESC LIMIT 200")
    for item in mobile:
        item["active"]=item["expires"]>now
        try:item["scopes"]=json.loads(item["scopes"])
        except (ValueError,TypeError):item["scopes"]=[]
    devices=rows(DB,"SELECT id,label,kind,created,last_seen AS lastSeen,revoked "
                    "FROM devices ORDER BY last_seen DESC LIMIT 200")
    assistants=rows(DB,"SELECT id,label,role,created,expires,last_used AS lastUsed,revoked "
                    "FROM assistant_keys ORDER BY created DESC LIMIT 200")
    principals=rows(IDENTITY_V3,"SELECT username,kind,role,status,created "
                    "FROM principals ORDER BY username LIMIT 200")
    oidc=rows(Path("/var/lib/nxc-oidc-vps/audit.sqlite3"),
               "SELECT issue,created,action,state FROM operations "
               "ORDER BY created DESC LIMIT 20")
    try:
        who=subprocess.run(["who"],capture_output=True,text=True,timeout=4).stdout.splitlines()[:40]
    except (OSError,subprocess.TimeoutExpired):
        who=[]
    return {"generatedAt":now,"linuxAccounts":accounts,"mobileApiKeys":mobile,
            "webDevices":devices,"assistantKeys":assistants,
            "principals":principals,"recentOidcOperations":oidc,
            "activeLinuxSessions":who,
            "coverageNote":"Inventaire local : des accès via panneau hébergeur, IAM externe, "
              "certificats SSH ou autres contrôleurs peuvent exister sans apparaître ici."}

def shell_status():
    r = subprocess.run(["systemctl","list-units","--type=service","--all",
        "--no-pager","--plain","--no-legend"],capture_output=True,text=True,timeout=8)
    allowed_prefixes=("nex","stacy","knowme","otaku","anime","whatsapp")
    services=[]
    for line in r.stdout.splitlines():
        cols=line.split(None,4)
        if len(cols)>=4 and cols[0].lower().startswith(allowed_prefixes):
            services.append({"name":cols[0],"load":cols[1],"active":cols[2],"sub":cols[3]})
    return services[:100]

def dashboard():
    return """<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>NexControl · VPS autonome</title><style>
    :root{color-scheme:dark;--bg:#090e18;--pane:#151f2e;--soft:#263649;--text:#eaf3fc;--muted:#9cb0c9;--accent:#6ec9c3}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top right,#143a45,#090e18 65%);font:15px system-ui,Arial;color:var(--text);min-height:100vh}
    main{max-width:1120px;margin:auto;padding:24px 18px 70px}header{display:flex;align-items:center;justify-content:space-between;gap:12px}
    h1{font-size:clamp(27px,5vw,38px);letter-spacing:-.06em;margin:6px 0}h2{font-size:18px;margin:0 0 16px}
    p,.muted{color:var(--muted)}a{color:var(--accent)}.panel{background:#151f2ee8;border:1px solid #35516b77;border-radius:23px;padding:20px;margin-top:17px;box-shadow:0 16px 48px #0003}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
    .metric{font-weight:750;font-size:24px;margin-top:12px;overflow-wrap:anywhere}input,button,select{font:inherit;border-radius:14px;padding:13px;border:1px solid #465974;color:var(--text);background:var(--soft);max-width:100%}
    button{background:#1c7776;cursor:pointer;font-weight:700;border-color:#318e89}button:hover{background:#218b88}button:disabled{opacity:.5}input{width:100%;margin:7px 0 12px}
    table{border-collapse:collapse;width:100%}td,th{padding:9px 6px;text-align:left;border-bottom:1px solid #33485e;font-size:13px}
    .scroll{overflow:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0b1422;padding:16px;border-radius:14px;font:12px ui-monospace,monospace}
    .ok{color:#77e6ba}.bad{color:#ffac93}small{color:var(--muted)}
    </style></head><body><main><header><div><small>VPS FIRST · AUCUNE EDGE FUNCTION</small><h1>NexControl</h1><p>Console autonome · supervision et diagnostics</p></div><a href="/nexai/">NexAI Connect ↗</a></header>
    <div id="login" class="panel" style="max-width:440px"><h2>Accès administrateur</h2><form id="loginForm"><label>Mot de passe NexControl</label><input name="password" type="password" autocomplete="current-password" required><label>Nom de cet appareil</label><input name="deviceName" placeholder="Mon PC ou Mon téléphone" maxlength="55" required><label>Type d'appareil</label><select name="deviceType"><option value="desktop">Ordinateur</option><option value="mobile">Téléphone</option><option value="tablet">Tablette</option><option value="web">Navigateur</option></select><button>Se connecter et identifier cet appareil</button></form><p id="loginMsg"></p></div>
    <div id="board" hidden><div class="panel" id="connectionPanel" role="status" aria-live="polite">Connexion au VPS en cours…</div><div class="grid"><div class="panel">Serveur<div class="metric" id="server">—</div></div>
    <div class="panel">RAM disponible<div class="metric" id="memory">—</div></div><div class="panel">Agent principal<div class="metric" id="agent">—</div></div>
    <div class="panel">Agent hôte<div class="metric" id="host">—</div></div></div>
    <div class="panel"><h2>Comptes NexControl · identités V3</h2>
    <p id="identityState">Chargement des identités et du journal…</p>
    <div class="scroll"><table><thead><tr><th>Utilisateur / service</th><th>Type</th><th>Rôle</th><th>État</th></tr></thead>
    <tbody id="identityRows"></tbody></table></div>
    <h2 style="margin-top:22px">Historique des opérations root et services</h2>
    <p class="muted">Horodatage, auteur technique, canal et résultat. Les secrets et sorties de commandes sont exclus.</p>
    <div class="scroll"><table><thead><tr><th>Heure</th><th>Compte</th><th>Canal</th><th>Action</th><th>Résultat</th></tr></thead>
    <tbody id="identityAuditRows"></tbody></table></div></div>
    <div class="panel"><h2>Qui a accès au VPS ?</h2><p id="inventoryNotice">Inventaire des comptes Linux, clés API, appareils et relais root…</p>
    <button id="inventoryRefresh">Actualiser l’inventaire</button>
    <div class="scroll"><table><thead><tr><th>Identité / accès</th><th>Type</th><th>Autorisation</th><th>État</th></tr></thead><tbody id="inventoryRows"></tbody></table></div>
    <small>Les accès externes de l’hébergeur et les identités IAM externes nécessitent un audit séparé.</small></div>
    <div class="panel"><h2>Services NexTech</h2><div class="scroll"><table><thead><tr><th>Service</th><th>État</th></tr></thead><tbody id="services"></tbody></table></div></div>
    <div class="panel"><h2>Appareils autorisés</h2><p>Chaque appareil possède une identité unique. Révoquer l'un d'eux n'interrompt pas les autres.</p><div class="scroll"><table><thead><tr><th>Appareil</th><th>Type</th><th>Dernière activité</th><th>Action</th></tr></thead><tbody id="devices"></tbody></table></div></div>
    <div class="panel"><h2>Accès assistant · permissions limitées</h2><p>Clés temporaires : consultation (6 heures) ou opérateur (30 minutes, redémarrage de deux agents de supervision seulement). Jamais d'accès SSH ni de commandes arbitraires. Ne partagez pas les clés dans une conversation.</p>
    <button id="keyCreate">Créer une clé de lecture</button><button id="keyOperate">Autoriser l’opérateur (30 min)</button><p id="keyNotice"></p><pre id="keyOnce" hidden></pre>
    <div class="scroll"><table><thead><tr><th>Clé</th><th>Rôle</th><th>Expiration</th><th>Révoquer</th></tr></thead><tbody id="accessKeys"></tbody></table></div></div>
    <div class="panel"><h2>Diagnostic</h2><button id="diag">Diagnostic agent NexControl</button>
    <button id="hostDiag">Diagnostic agent hôte</button><button id="refresh">Actualiser</button><button id="logout">Déconnexion</button>
    <p id="notice"></p><pre id="result">Aucun diagnostic lancé.</pre><h2>Historique de l’agent hôte</h2><pre id="hostResult">Aucun diagnostic hôte lancé.</pre></div>
    </div></main><script>
    const $=id=>document.getElementById(id);
    async function req(path,options={}){const r=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});let data=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(data.error||'HTTP '+r.status);e.status=r.status;throw e}return data}
    async function refresh(){try{const a=await req('/api/nxc/status');$('login').hidden=true;$('board').hidden=false;$('connectionPanel').textContent='VPS connecté · Dernière synchronisation '+new Date().toLocaleTimeString('fr-FR');
    $('server').textContent=a.hostname+' · '+a.uptimeHours+'h';$('memory').textContent=a.memoryAvailableMiB+' MiB';
    $('agent').textContent=a.agentAgeSeconds===null?'Non relié':a.agentAgeSeconds+'s';$('host').textContent=a.hostAgeSeconds===null?'Non relié':a.hostAgeSeconds+'s';
    $('services').replaceChildren(...a.services.map(x=>{const row=document.createElement('tr'),name=document.createElement('td'),state=document.createElement('td');name.textContent=x.name;state.textContent=x.active+'/'+x.sub;state.className=x.active==='active'?'ok':'bad';row.append(name,state);return row}));
    try{const ident=await req('/api/nxc/identity/v3');$('identityState').textContent=ident.ready
       ?ident.accounts.length+' identité(s) · '+ident.devices+' appareil(s) · '+ident.sessions+' session(s) · '+ident.events.length+' événements récents'
       :'Registre V3 non initialisé';
       $('identityRows').replaceChildren(...ident.accounts.map(x=>{const row=document.createElement('tr');for(const v of [x.username,x.kind,x.role,x.status]){const c=document.createElement('td');c.textContent=v;row.append(c)}return row}));
       $('identityAuditRows').replaceChildren(...ident.events.map(x=>{const row=document.createElement('tr');for(const v of [new Date(x.timestamp*1000).toLocaleString(),x.actor,x.channel,x.action,x.outcome]){const c=document.createElement('td');c.textContent=v;row.append(c)}return row}));
    }catch(ex){$('identityState').textContent='Journal momentanément indisponible ('+ex.message+'). Les autres fonctions restent accessibles.';}
    try{const all=await req('/api/nxc/access/inventory'),rows=[];
      const add=(who,kind,grant,state)=>{const tr=document.createElement('tr');for(const val of [who,kind,grant,state]){const td=document.createElement('td');td.textContent=String(val);tr.append(td)}rows.push(tr)};
      for(const x of all.linuxAccounts)add(x.username,'Linux · UID '+x.uid,
        (x.sudoMember?'sudo · ':'')+(x.dockerMember?'docker · ':'')+x.authorizedKeyEntries+' clé(s) autorisée(s)',x.shell);
      for(const x of all.principals)add(x.username,'Compte NexControl V3',x.role,x.status);
      for(const x of all.mobileApiKeys)add(x.label,'Clé API mobile',x.scopes.join(', '),x.active?'active':'expirée');
      for(const x of all.webDevices)add(x.label,'Appareil web',x.kind,x.revoked?'révoqué':'enregistré');
      for(const x of all.assistantKeys)add(x.label,'Clé technique',x.role,x.revoked?'révoquée':'enregistrée');
      add('GitHub OIDC','Relais technique root','Identité de workflow vérifiée',all.recentOidcOperations.length+' opération(s) récentes');
      $('inventoryRows').replaceChildren(...rows);
      $('inventoryNotice').textContent=rows.length+' accès et identités observés dans les registres locaux.';
    }catch(ex){$('inventoryNotice').textContent='Inventaire indisponible : '+ex.message;}
    const jobs=await req('/api/nxc/jobs');$('result').textContent=JSON.stringify(jobs.jobs,null,2);
    const hostJobs=await req('/api/nxc/host/jobs');$('hostResult').textContent=JSON.stringify(hostJobs.jobs,null,2);
    const registered=await req('/api/nxc/devices');
    $('devices').replaceChildren(...registered.devices.map(x=>{
       const row=document.createElement('tr'),label=document.createElement('td'),kind=document.createElement('td'),activity=document.createElement('td'),actions=document.createElement('td'),revoke=document.createElement('button');
       label.textContent=x.label+(x.current?' (cet appareil)':'');kind.textContent=x.kind;
       activity.textContent=new Date(x.lastSeen*1000).toLocaleString();
       revoke.textContent='Révoquer';revoke.onclick=async()=>{if(!confirm('Révoquer '+x.label+' ? Ses sessions seront désactivées immédiatement.'))return;
         await req('/api/nxc/devices/revoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:x.id})});await refresh()};
       actions.append(revoke);row.append(label,kind,activity,actions);return row}));
    const access=await req('/api/nxc/access');$('accessKeys').replaceChildren(...access.keys.map(x=>{
       const row=document.createElement('tr'),name=document.createElement('td'),role=document.createElement('td'),expiry=document.createElement('td'),action=document.createElement('td'),button=document.createElement('button');
       name.textContent=x.label;role.textContent=x.role;expiry.textContent=new Date(x.expires*1000).toLocaleString();
       button.textContent='Révoquer';button.onclick=async()=>{if(!confirm('Révoquer cette clé ?'))return;await req('/api/nxc/access/revoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:x.id})});await refresh()};
       action.append(button);row.append(name,role,expiry,action);return row}));
    }catch(e){if(e.status===401){$('board').hidden=true;$('login').hidden=false;$('loginMsg').textContent='Session expirée, appareil révoqué ou accès modifié. Reconnecte cet appareil pour rétablir la session.';}else{$('connectionPanel').textContent='Connexion au VPS interrompue ('+e.message+'). Les données affichées peuvent être anciennes. Nouvel essai automatique.';if($('board').hidden)$('loginMsg').textContent='Le VPS est temporairement indisponible. Réessai automatique sans effacer ton appareil.';}}}
    $('loginForm').onsubmit=async e=>{e.preventDefault();try{await req('/api/nxc/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:e.target.elements.password.value,deviceName:e.target.elements.deviceName.value,deviceType:e.target.elements.deviceType.value})});e.target.password.value='';await refresh()}catch(ex){$('loginMsg').textContent=ex.message}};
    $('refresh').onclick=refresh;
    $('inventoryRefresh').onclick=refresh;
    {const form=$('loginForm'),mobile=/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
     form.elements.deviceType.value=mobile?'mobile':'desktop';
     form.elements.deviceName.value=mobile?'Mon téléphone':'Mon ordinateur';}
    async function issueKey(role){try{
       if(role==='operator'&&!confirm('Autoriser pendant 30 min le redémarrage des deux agents de supervision NexControl/NexForge ? Aucun shell ni action sur les bots.'))return;
       const x=await req('/api/nxc/access/issue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:role==='operator'?'ChatGPT operator':'ChatGPT observer',role})});
       $('keyOnce').hidden=false;$('keyOnce').textContent=x.token;
       $('keyNotice').textContent='Clé '+x.role+' affichée une seule fois, expiration : '+new Date(x.expires*1000).toLocaleString();
       await refresh()}catch(e){$('keyNotice').textContent=e.message}}
    $('keyCreate').onclick=()=>issueKey('observer');
    $('keyOperate').onclick=()=>issueKey('operator');
    $('hostDiag').onclick=async()=>{try{const x=await req('/api/nxc/host/job',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'system.info'})});$('notice').textContent='Diagnostic agent hôte envoyé : '+x.jobId;setTimeout(refresh,1500)}catch(ex){$('notice').textContent=ex.message}};
    $('diag').onclick=async()=>{try{const x=await req('/api/nxc/job',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'system.info'})});$('notice').textContent='Diagnostic envoyé à l’agent : '+x.jobId;setTimeout(refresh,1600)}catch(ex){$('notice').textContent=ex.message}};
    $('logout').onclick=async()=>{await req('/api/nxc/logout',{method:'POST'});await refresh()};
    refresh();setInterval(()=>{if(!$('board').hidden)refresh()},20000);
    </script></body></html>"""

class Handler(BaseHTTPRequestHandler):
    server_version = "NexControl-VPS/1.0"
    def log_message(self, fmt, *args):
        # No pairing keys, codes, URLs or credentials in access logs.
        if not self.path.startswith("/api/nexai-connect"): return super().log_message(fmt,*args)

    def ip(self):
        return (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()[:50]

    def send(self, code, data, headers=None):
        out=json.dumps(data,ensure_ascii=False,separators=(",",":")).encode()
        self.send_response(code)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        if headers:
            for k,v in (headers.items() if isinstance(headers,dict) else headers): self.send_header(k,v)
        self.send_header("Content-Length",str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def page(self, code, contents, mimetype="text/html; charset=utf-8"):
        raw=contents.encode() if isinstance(contents,str) else contents
        self.send_response(code)
        self.send_header("Content-Type",mimetype)
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Content-Length",str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self, max_size=8192):
        n=int(self.headers.get("content-length") or 0)
        if n<0 or n>max_size: raise ValueError("request_too_large")
        raw=self.rfile.read(n) if n else b"{}"
        x=json.loads(raw)
        if not isinstance(x,dict): raise ValueError("invalid_json")
        return x

    def current_device(self):
        match=re.search(r"(?:^|;\s*)__Host-nxc_device=([a-f0-9]{32})\.([a-f0-9]{64})(?:;|$)",self.headers.get("Cookie",""))
        if not match: return None
        dev_id,secret=match.group(1),match.group(2)
        with connection() as d:
            record=d.execute("SELECT token_hash FROM devices WHERE id=? AND revoked=0",(dev_id,)).fetchone()
        if not record or not hmac.compare_digest(record["token_hash"],hashlib.sha256(secret.encode()).hexdigest()):
            return None
        return dev_id

    def admin(self):
        m=re.search(r"(?:^|;\s*)__Host-nxc_sid=([a-f0-9]{64})(?:;|$)",self.headers.get("Cookie",""))
        if not m: return False
        digest=hashlib.sha256(m.group(1).encode()).hexdigest()
        with connection() as d:
            row=d.execute("SELECT expires,device_id FROM sessions WHERE hash=?",(digest,)).fetchone()
        if not row or row["expires"]<=time.time(): return False
        # Older eight-hour sessions remain valid until their natural expiry.
        if row["device_id"] is not None:
            if row["device_id"]!=self.current_device(): return False
            with connection() as d:
                d.execute("UPDATE devices SET last_seen=?,last_ip=? WHERE id=? AND last_seen<?",
                          (int(time.time()),self.ip(),row["device_id"],int(time.time())-60))
        return True

    def local_origin(self):
        # Trust the dedicated, reviewed Vercel static UI without accepting
        # arbitrary browser origins or a wildcard. The backend still performs
        # credential checks and CSRF mitigation on state-changing requests.
        origin=self.headers.get("Origin","")
        allowed={ORIGIN,"https://nexcontrol-nexus-vps.vercel.app"}
        return not origin or origin in allowed

    def assistant(self, required="observer"):
        """Return key ID only for a valid role-scoped token, never disclose the key."""
        token=self.headers.get("Authorization","")
        match=re.fullmatch(r"Bearer ([A-Za-z0-9_-]{40,120})",token)
        if not match or not allowed(self.ip(),"assistant",120,60): return None
        digest=hashlib.sha256(match.group(1).encode()).hexdigest()
        now=int(time.time())
        with connection() as d:
            row=d.execute("SELECT id,role FROM assistant_keys WHERE digest=? AND revoked=0 AND expires>?",
                          (digest,now)).fetchone()
            if row and (required=="observer" or row["role"]==required):
                d.execute("UPDATE assistant_keys SET last_used=? WHERE id=?",(now,row["id"]))
                return row["id"]
        return None

    def pairing(self, method, q):
        action=q.get("api",[""])[0]
        options={"pair-key":("GET","public-key"),"pair-secure":("POST","secure"),
             "pair-status":("GET","pair-status"),"qr-start":("POST","qr-start"),
             "qr-status":("GET","qr-status"),"qr-cancel":("POST","qr-cancel")}
        if action not in options or options[action][0]!=method:
            return self.send(405,{"ok":False,"error":"invalid_pairing_action"})
        if not allowed(self.ip(), "pairStatus" if action.endswith("status") else "pair", 160 if action.endswith("status") else 24):
            return self.send(429,{"ok":False,"error":"rate_limited"})
        args=[]
        if action=="pair-secure":
            p=self.read_json(2500); envelope=str(p.get("envelope") or "")
            if not re.fullmatch(r"[A-Za-z0-9+/=]{400,900}",envelope):
                return self.send(400,{"ok":False,"error":"invalid_envelope"})
            args=[envelope]
        elif action in ("pair-status","qr-status","qr-cancel"):
            ident=q.get("id",[""])[0]
            if not re.fullmatch(r"[0-9a-fA-F-]{20,60}",ident):
                return self.send(400,{"ok":False,"error":"invalid_pair_id"})
            args=[ident]
        if not Path(PAIR_CLI).is_file():
            return self.send(503,{"ok":False,"error":"pairing_cli_not_installed"})
        if not PAIR_SLOTS.acquire(blocking=False):
            return self.send(503,{"ok":False,"error":"pairing_busy"})
        try:
            proc=subprocess.run(["node",PAIR_CLI,options[action][1],*args],
                cwd=str(Path(PAIR_CLI).parent),capture_output=True,text=True,
                timeout=56 if action=="pair-secure" else 34,env=os.environ.copy())
            if proc.returncode:
                # The CLI exits non-zero for both normal Telegram validation errors
                # and actual backend failures. Never misreport a bad phone/code as
                # "gateway unavailable"; only emit allowlisted, non-sensitive codes.
                reason=(proc.stderr or "").upper()
                if "INVALID TELEGRAM PHONE NUMBER" in reason or "PHONE_NUMBER_INVALID" in reason:
                    return self.send(400,{"ok":False,"error":"PHONE_NUMBER_INVALID","errorCode":"PHONE_NUMBER_INVALID"})
                for code in ("PHONE_CODE_INVALID","PHONE_CODE_EMPTY","PHONE_CODE_EXPIRED",
                             "PASSWORD_HASH_INVALID","PASSWORD_EMPTY","SIGN_UP_REQUIRED",
                             "EMAIL_VERIFICATION_REQUIRED","PHONE_NUMBER_BANNED"):
                    if code in reason:
                        return self.send(409,{"ok":False,"error":code,"errorCode":code})
                if "FLOOD_WAIT" in reason:
                    return self.send(429,{"ok":False,"error":"FLOOD_WAIT","errorCode":"FLOOD_WAIT"})
                if "UNAUTHORIZED" in reason or "HTTP 401" in reason:
                    return self.send(503,{"ok":False,"error":"pairing_gateway_authorization_failed"})
                return self.send(503,{"ok":False,"error":"pairing_process_failed"})
            raw=proc.stdout.strip()
            try: data=json.loads(raw)
            except ValueError:
                try: data=json.loads(raw.splitlines()[-1])
                except (ValueError,IndexError): return self.send(502,{"ok":False,"error":"pairing_invalid_response"})
            if not isinstance(data,dict):
                return self.send(502,{"ok":False,"error":"pairing_invalid_response"})
            return self.send(200 if data.get("ok") is not False else 409,data)
        except subprocess.TimeoutExpired:
            return self.send(504,{"ok":False,"error":"pairing_timeout"})
        finally: PAIR_SLOTS.release()

    def host_rpc(self, path):
        try: p=self.read_json(16000)
        except (ValueError,json.JSONDecodeError): return self.send(400,{"error":"invalid_json"})
        if not host_auth(p): return self.send(401,{"error":"unauthorized"})
        agent=str(p["p_agent_id"])
        if path in ("nxf_host_heartbeat","nxf_host_poll"):
            now=int(time.time())
            with connection() as d:
                d.execute("BEGIN IMMEDIATE")
                d.execute("INSERT INTO host_agents(id,last_seen,details) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,details=excluded.details",
                    (agent,now,json.dumps(p.get("p_meta") or {})[:4000]))
                rows=[]
                if path.endswith("poll"):
                    rows=d.execute("SELECT id,kind,payload FROM host_jobs WHERE agent_id=? AND status='pending' ORDER BY created LIMIT 2",(agent,)).fetchall()
                    for row in rows: d.execute("UPDATE host_jobs SET status='running',claimed=? WHERE id=?",(now,row["id"]))
                d.execute("COMMIT")
            if path.endswith("poll"):
                return self.send(200,{"ok":True,"jobs":[{"id":row["id"],"kind":row["kind"],"payload":json.loads(row["payload"])} for row in rows]})
            return self.send(200,{"ok":True})
        if path=="nxf_host_result":
            jid=str(p.get("p_job_id") or "")
            if not re.fullmatch(r"[0-9a-f-]{36}",jid): return self.send(400,{"error":"invalid_job_id"})
            success=p.get("p_ok") is True
            result=json.dumps(p.get("p_result") or {},ensure_ascii=False)
            with connection() as d:
                cur=d.execute("UPDATE host_jobs SET status=?,completed=?,result=?,error=? WHERE id=? AND agent_id=? AND status='running'",
                  ("done" if success else "failed",int(time.time()),result[:120000],str(p.get("p_error") or "")[:1600],jid,agent))
            return self.send(200,{"ok":cur.rowcount>0})
        return self.send(404,{"error":"unknown_rpc"})

    def agent_api(self, path):
        if self.command!="POST": return self.send(405,{"error":"method_not_allowed"})
        slug=str(self.headers.get("x-nexcontrol-agent") or "").lower()
        key=str(self.headers.get("x-nexcontrol-agent-key") or "")
        if slug not in AGENT_SLUGS or not hmac.compare_digest(key,CONFIG["agent_key"]):
            return self.send(401,{"error":"unauthorized"})
        try: payload=self.read_json(20000)
        except (ValueError,json.JSONDecodeError): return self.send(400,{"error":"invalid_json"})
        now=int(time.time())
        if path.endswith("/heartbeat"):
            details={k:payload.get(k) for k in ("displayName","version","hostname","platform","nodeVersion","capabilities","roots")}
            with connection() as d:
                d.execute("INSERT INTO agents(slug,last_seen,details) VALUES (?,?,?) ON CONFLICT(slug) DO UPDATE SET last_seen=excluded.last_seen,details=excluded.details",
                    (slug,now,json.dumps(details)[:15000]))
            return self.send(200,{"ok":True,"agentId":slug})
        if path.endswith("/jobs/claim"):
            with connection() as d:
                d.execute("BEGIN IMMEDIATE")
                row=d.execute("SELECT id,kind,payload FROM jobs WHERE slug=? AND status='pending' ORDER BY created LIMIT 3",(slug,)).fetchall()
                for job in row: d.execute("UPDATE jobs SET status='running',claimed=? WHERE id=?",(now,job["id"]))
                d.execute("COMMIT")
            return self.send(200,{"jobs":[{"id":x["id"],"kind":x["kind"],"payload":json.loads(x["payload"])} for x in row]})
        if path.endswith("/jobs/result"):
            job_id=str(payload.get("jobId") or "")
            if not re.fullmatch("[0-9a-f-]{36}",job_id): return self.send(400,{"error":"invalid_job_id"})
            ok=payload.get("ok") is True
            with connection() as d:
                cur=d.execute("UPDATE jobs SET status=?,result=?,error=? WHERE id=? AND slug=? AND status='running'",
                    ("done" if ok else "failed",json.dumps(payload.get("result") or {})[:150000],str(payload.get("error") or "")[:2000],job_id,slug))
            return self.send(200,{"ok":True} if cur.rowcount else {"ok":False,"error":"job_not_found"})
        return self.send(404,{"error":"unknown_route"})

    def do_GET(self):
        self.dispatch("GET")
    def do_POST(self):
        self.dispatch("POST")
    def dispatch(self,method):
        try: self.handle_request(method)
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as exc:
            print("request failure:",type(exc).__name__,str(exc)[:200],file=sys.stderr,flush=True)
            try: self.send(500,{"ok":False,"error":"internal_error"})
            except (BrokenPipeError,ConnectionResetError): pass

    def handle_request(self,method):
        u=urlsplit(self.path); path=u.path; q=parse_qs(u.query,keep_blank_values=True)
        if path in ("/api/nxc/health","/healthz"):
            return self.send(200,{"ok":True,"service":"nexcontrol-vps","version":"1.0"})
        if path in ("/api/nxc/assistant/status","/api/nxc/assistant/health") and method=="GET":
            if not self.assistant(): return self.send(401,{"ok":False,"error":"assistant_key_required"})
            with connection() as d:
                agents=d.execute("SELECT slug,last_seen FROM agents ORDER BY last_seen DESC").fetchall()
                host=d.execute("SELECT id,last_seen FROM host_agents ORDER BY last_seen DESC LIMIT 5").fetchall()
            now=int(time.time())
            return self.send(200,{"ok":True,"service":"nexcontrol-vps","role":"observer",
                "hostname":os.uname().nodename,
                "agents":[{"slug":a["slug"],"ageSeconds":now-a["last_seen"]} for a in agents],
                "hostAgents":[{"id":h["id"],"ageSeconds":now-h["last_seen"]} for h in host],
                "services":shell_status()})
        if path=="/api/nxc/assistant/operate" and method=="POST":
            key_id=self.assistant(required="operator")
            if not key_id: return self.send(403,{"ok":False,"error":"operator_key_required"})
            if not self.local_origin(): return self.send(403,{"ok":False,"error":"invalid_origin"})
            if not allowed(self.ip(),"assistant_operate",4,300):
                return self.send(429,{"ok":False,"error":"operation_rate_limited"})
            p=self.read_json(512)
            action=str(p.get("action") or "")
            service=str(p.get("service") or "")
            safe_services=("nexcontrol-agent.service","nexforge-host-agent.service")
            if action not in ("status","restart") or service not in safe_services:
                return self.send(400,{"ok":False,"error":"operation_not_allowed"})
            r=subprocess.run(["systemctl","is-active" if action=="status" else "restart",
                              service],capture_output=True,text=True,timeout=20)
            audit("assistant.operation",key_id+":"+action+":"+service+":"+str(r.returncode))
            return self.send(200 if r.returncode==0 else 503,
              {"ok":r.returncode==0,"service":service,"action":action,
               "state":r.stdout.strip()[:60] if action=="status" else "requested"})
        if path=="/api/nexai-connect": return self.pairing(method,q)
        if path.startswith("/api/v1/agent/"): return self.agent_api(path)
        if path.startswith("/rest/v1/rpc/nxf_host_"): return self.host_rpc(path.removeprefix("/rest/v1/rpc/"))
        if path in ("/","/nexai","/nexcontrol"):
            return self.redirect("/nexcontrol/" if path=="/" or path=="/nexcontrol" else "/nexai/")
        if method=="GET" and path in ("/nexai/","/nexai/index.html","/nexai/style.css","/nexai/app.js"):
            name=path.rsplit("/",1)[-1] or "index.html"
            file=Path("/opt/nxc-vps/site") / name
            if not file.is_file(): return self.send(404,{"error":"site_file_missing"})
            mimetype="text/css; charset=utf-8" if name.endswith(".css") else "application/javascript; charset=utf-8" if name.endswith(".js") else "text/html; charset=utf-8"
            return self.page(200,file.read_bytes(),mimetype)
        if method=="GET" and path=="/nexcontrol/": return self.page(200,dashboard())
        if path=="/api/nxc/login" and method=="POST":
            if not self.local_origin(): return self.send(403,{"error":"invalid_origin"})
            if not allowed(self.ip(),"login",6,300): return self.send(429,{"error":"too_many_attempts"})
            p=self.read_json(1000)
            if not validate_password(p.get("password")): return self.send(401,{"error":"identifiants_invalides"})
            label=str(p.get("deviceName") or "Appareil NexControl").strip()
            kind=str(p.get("deviceType") or "web").strip()
            if not 2<=len(label)<=55 or any(ord(c)<32 for c in label):
                return self.send(400,{"error":"invalid_device_name"})
            if kind not in ("desktop","mobile","tablet","web"):
                return self.send(400,{"error":"invalid_device_type"})
            now=int(time.time());existing=self.current_device()
            token=secrets.token_hex(32)
            cookies=[("Set-Cookie","__Host-nxc_sid="+token+"; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800")]
            with connection() as d:
                d.execute("BEGIN IMMEDIATE")
                if existing:
                    device_id=existing
                    d.execute("UPDATE devices SET label=?,kind=?,last_seen=?,last_ip=?,user_agent=? WHERE id=?",
                        (label,kind,now,self.ip(),self.headers.get("User-Agent","")[:180],device_id))
                else:
                    if d.execute("SELECT count(*) FROM devices WHERE revoked=0").fetchone()[0]>=32:
                        return self.send(409,{"error":"device_limit_reached"})
                    device_id=secrets.token_hex(16)
                    device_secret=secrets.token_hex(32)
                    d.execute("INSERT INTO devices(id,token_hash,label,kind,created,last_seen,last_ip,user_agent) VALUES (?,?,?,?,?,?,?,?)",
                      (device_id,hashlib.sha256(device_secret.encode()).hexdigest(),label,kind,now,now,self.ip(),self.headers.get("User-Agent","")[:180]))
                    cookies.append(("Set-Cookie","__Host-nxc_device="+device_id+"."+device_secret+"; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000"))
                d.execute("DELETE FROM sessions WHERE expires<?",(now,))
                d.execute("INSERT INTO sessions(hash,expires,device_id) VALUES (?,?,?)",
                    (hashlib.sha256(token.encode()).hexdigest(),now+8*3600,device_id))
                d.execute("COMMIT")
            audit("admin.login.device",device_id+":"+kind)
            return self.send(200,{"ok":True,"deviceId":device_id},cookies)
        if path.startswith("/api/nxc/"):
            if not self.admin(): return self.send(401,{"error":"connexion_requise"})
            if method=="POST" and not self.local_origin(): return self.send(403,{"error":"invalid_origin"})
            if path=="/api/nxc/identity/v3" and method=="GET":
                try: return self.send(200,account_audit_snapshot())
                except sqlite3.Error: return self.send(503,{"error":"identity_audit_temporarily_unavailable"})
            if path=="/api/nxc/access/inventory" and method=="GET":
                try:return self.send(200,access_inventory())
                except (sqlite3.Error,OSError):return self.send(503,{"error":"inventory_unavailable"})
            if path=="/api/nxc/devices" and method=="GET":
                current=self.current_device()
                with connection() as d:
                    rows=d.execute("SELECT id,label,kind,created,last_seen FROM devices WHERE revoked=0 ORDER BY last_seen DESC").fetchall()
                return self.send(200,{"devices":[{"id":x["id"],"label":x["label"],"kind":x["kind"],"created":x["created"],
                    "lastSeen":x["last_seen"],"current":x["id"]==current} for x in rows]})
            if path=="/api/nxc/devices/revoke" and method=="POST":
                p=self.read_json(256)
                device_id=str(p.get("id") or "")
                if not re.fullmatch(r"[0-9a-f]{32}",device_id): return self.send(400,{"error":"invalid_device_id"})
                is_current=device_id==self.current_device()
                with connection() as d:
                    d.execute("BEGIN IMMEDIATE")
                    cur=d.execute("UPDATE devices SET revoked=1 WHERE id=? AND revoked=0",(device_id,))
                    d.execute("DELETE FROM sessions WHERE device_id=?",(device_id,))
                    d.execute("COMMIT")
                audit("device.revoke",device_id)
                headers=[]
                if is_current:
                    headers=[("Set-Cookie","__Host-nxc_sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"),
                        ("Set-Cookie","__Host-nxc_device=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0")]
                return self.send(200,{"ok":cur.rowcount>0},headers)
            if path=="/api/nxc/access" and method=="GET":
                with connection() as d:
                    rows=d.execute("SELECT id,label,role,created,expires,last_used FROM assistant_keys WHERE revoked=0 AND expires>? ORDER BY created DESC",(int(time.time()),)).fetchall()
                return self.send(200,{"keys":[dict(x) for x in rows]})
            if path=="/api/nxc/access/issue" and method=="POST":
                if not allowed(self.ip(),"assistant_issue",4,3600):
                    return self.send(429,{"error":"issuance_rate_limited"})
                p=self.read_json(450)
                label=str(p.get("label") or "ChatGPT observer")[:60].strip()
                role=str(p.get("role") or "observer")
                if role not in ("observer","operator"):
                    return self.send(400,{"error":"invalid_role"})
                if not re.fullmatch(r"[A-Za-z0-9À-ž ._-]{2,60}",label):
                    return self.send(400,{"error":"invalid_label"})
                token=secrets.token_urlsafe(36)
                digest=hashlib.sha256(token.encode()).hexdigest()
                key_id=str(__import__("uuid").uuid4())
                now=int(time.time());expires=now+(30*60 if role=="operator" else 6*3600)
                with connection() as d:
                    d.execute("DELETE FROM assistant_keys WHERE expires<?",(now-14*24*3600,))
                    d.execute("INSERT INTO assistant_keys(id,digest,label,role,created,expires) VALUES(?,?,?,?,?,?)",(key_id,digest,label,role,now,expires))
                audit("assistant.issue",key_id+":"+role)
                return self.send(201,{"ok":True,"id":key_id,"role":role,"token":token,"expires":expires})
            if path=="/api/nxc/access/revoke" and method=="POST":
                p=self.read_json(300)
                key_id=str(p.get("id") or "")
                if not re.fullmatch(r"[0-9a-f-]{36}",key_id):
                    return self.send(400,{"error":"invalid_key_id"})
                with connection() as d:
                    cur=d.execute("UPDATE assistant_keys SET revoked=1 WHERE id=? AND revoked=0",(key_id,))
                audit("assistant.revoke",key_id)
                return self.send(200,{"ok":cur.rowcount>0})
            if path=="/api/nxc/host/jobs" and method=="GET":
                with connection() as d:
                    rows=d.execute("SELECT id,agent_id,kind,status,created,claimed,completed,result,error FROM host_jobs ORDER BY created DESC LIMIT 10").fetchall()
                return self.send(200,{"jobs":[dict(x) for x in rows]})
            if path=="/api/nxc/host/job" and method=="POST":
                p=self.read_json(1500);kind=str(p.get("kind") or "")
                allowed_kinds=("system.info","process.list","disk.usage","net.info")
                if kind not in allowed_kinds:
                    return self.send(400,{"error":"host_job_kind_not_allowed"})
                with connection() as d:
                    row=d.execute("SELECT id,last_seen FROM host_agents ORDER BY last_seen DESC LIMIT 1").fetchone()
                    if not row or row["last_seen"]<int(time.time())-120:
                        return self.send(503,{"error":"host_agent_not_connected"})
                    job_id=str(__import__("uuid").uuid4())
                    d.execute("INSERT INTO host_jobs(id,agent_id,kind,payload,created) VALUES (?,?,?,?,?)",
                        (job_id,row["id"],kind,"{}",int(time.time())))
                audit("host.job",kind)
                return self.send(202,{"ok":True,"jobId":job_id})
            if path=="/api/nxc/logout" and method=="POST":
                m=re.search(r"(?:^|;\\s*)__Host-nxc_sid=([a-f0-9]{64})(?:;|$)",self.headers.get("Cookie",""))
                if m:
                    with connection() as d:
                        d.execute("DELETE FROM sessions WHERE hash=?",(hashlib.sha256(m.group(1).encode()).hexdigest(),))
                return self.send(200,{"ok":True},{"Set-Cookie":"__Host-nxc_sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"})
            if path=="/api/nxc/status" and method=="GET":
                with connection() as d:
                    a=d.execute("SELECT last_seen FROM agents WHERE slug='nexus-main'").fetchone()
                    h=d.execute("SELECT max(last_seen) m FROM host_agents").fetchone()
                mem=0
                try:
                    m=re.search(r"^MemAvailable:\s+(\d+)\s+kB",Path("/proc/meminfo").read_text(),re.M)
                    if m: mem=int(m.group(1))//1024
                except OSError: pass
                try: uptime=int(float(Path("/proc/uptime").read_text().split()[0])//3600)
                except (OSError,ValueError): uptime=0
                return self.send(200,{"ok":True,"hostname":os.uname().nodename,
                  "uptimeHours":uptime,"memoryAvailableMiB":mem,
                  "agentAgeSeconds":int(time.time())-a["last_seen"] if a else None,
                  "hostAgeSeconds":int(time.time())-h["m"] if h and h["m"] else None,
                  "services":shell_status()})
            if path=="/api/nxc/jobs" and method=="GET":
                with connection() as d:
                    rows=d.execute("SELECT id,slug,kind,status,created,claimed,result,error FROM jobs ORDER BY created DESC LIMIT 12").fetchall()
                return self.send(200,{"jobs":[dict(x) for x in rows]})
            if path=="/api/nxc/job" and method=="POST":
                p=self.read_json(2000); kind=str(p.get("kind") or "")
                if kind not in ("system.info","process.list","service.list","disk.usage"):
                    return self.send(400,{"error":"job_kind_not_allowed"})
                job_id=__import__("uuid").uuid4().hex
                job_id=job_id[:8]+"-"+job_id[8:12]+"-"+job_id[12:16]+"-"+job_id[16:20]+"-"+job_id[20:]
                with connection() as d:
                    d.execute("INSERT INTO jobs(id,slug,kind,payload,created) VALUES (?,?,?,?,?)",
                        (job_id,"nexus-main",kind,"{}",int(time.time())))
                audit("agent.job",kind)
                return self.send(202,{"ok":True,"jobId":job_id})
        return self.send(404,{"error":"not_found"})

    def redirect(self,dest):
        self.send_response(302);self.send_header("Location",dest);self.send_header("Content-Length","0");self.end_headers()

if __name__=="__main__":
    initialize()
    server=ThreadingHTTPServer(("127.0.0.1",18731),Handler)
    server.daemon_threads=True
    print("NexControl VPS direct plane listening on 127.0.0.1:18731",flush=True)
    server.serve_forever(poll_interval=0.5)
