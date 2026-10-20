#!/usr/bin/env python3
"""Patch the already-running Nex WhatsApp publisher's post-pair credential flush.

This deploy intentionally preserves the live publisher and user credentials.
Usage: python3 deploy-whatsapp-pairing-515-20261020.py --check | --deploy
"""
from pathlib import Path
import argparse
import datetime
import json
import os
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT=Path('/opt/nex/apps/internal/whatsapp-publisher/current')
SERVER=ROOT/'server.mjs'
AUTH=Path('/var/lib/nex/data/internal/whatsapp-publisher/wa-auth/creds.json')
UNIT='nex-whatsapp-publisher.service'
MARKER='NEX_WA_CREDENTIALS_FLUSH_20261020'

def run(*args, check=True):
    return subprocess.run(args,check=check,timeout=50,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)

def alter(src):
    if MARKER in src: return src
    replacements=(
        ("  sock.ev.on('creds.update',saveCreds);",
"""  // NEX_WA_CREDENTIALS_FLUSH_20261020: serialize writes before 515 reconnect.
  let pendingCredentialSave=Promise.resolve();
  sock.ev.on('creds.update',()=>{
    pendingCredentialSave=pendingCredentialSave
      .catch(error=>logger.warn({error:String(error?.message||error)},'Previous WhatsApp credential save failed'))
      .then(()=>saveCreds());
    return pendingCredentialSave;
  });"""),
        ("        reconnectTimer=setTimeout(()=>connectWhatsApp().catch(e=>logger.error({err:e},'WhatsApp reconnect failed')),900);",
"""        reconnectTimer=setTimeout(()=>{
          (async()=>{
            // After 515, keys must be on disk before the new socket reloads them.
            await pendingCredentialSave;
            await saveCreds();
            await connectWhatsApp();
          })().catch(e=>logger.error({err:e},'WhatsApp post-pair reconnect failed'));
        },1500);""")
    )
    for before,after in replacements:
        if src.count(before)!=1:
            raise RuntimeError('Unexpected live version; refusing unreviewed changes: '+before[:55])
        src=src.replace(before,after,1)
    return src

def req(url):
    try:
        with urllib.request.urlopen(url,timeout=7) as res:
            return res.status, res.read(1000).decode('utf-8','replace')
    except urllib.error.HTTPError as error:
        return error.code,''
    except Exception:
        return 0,''

def healthy():
    service=run('systemctl','is-active',UNIT,check=False).stdout.strip()
    code,_=req('http://127.0.0.1:8787/healthz')
    route,_=req('http://127.0.0.1:8787/api/quick-connect/status')
    protected,_=req('http://127.0.0.1:8787/api/status')
    print(f'SERVICE={service} HEALTH={code} PAIR_STATUS={route} ADMIN_GUARD={protected}',flush=True)
    return (service=='active' and code==200 and route==200 and protected==401)

def main():
    parser=argparse.ArgumentParser()
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--check',action='store_true')
    group.add_argument('--deploy',action='store_true')
    args=parser.parse_args()
    if not SERVER.is_file() or not AUTH.is_file() or not (ROOT/'quick-connect.html').is_file():
        raise RuntimeError('Expected live publisher or session missing; no changes attempted')
    src=SERVER.read_text('utf-8')
    if 'NEX_WA_QUICK_CONNECT_OCT2026' not in src:
        raise RuntimeError('Direct-pair feature is not active; refusing patch')
    patched=alter(src)
    if not healthy():
        raise RuntimeError('Live publisher preflight failed; no changes attempted')
    with tempfile.NamedTemporaryFile('w',encoding='utf-8',suffix='.mjs',dir=ROOT,delete=False) as handle:
        tmp=Path(handle.name)
        handle.write(patched)
    try:
        run('node','--check',str(tmp))
        print('PATCH_SYNTAX=valid PATCH_ALREADY_INSTALLED='+str(patched==src),flush=True)
        if args.check: return
        if patched==src: print('DEPLOYED=already-installed'); return
        backup_dir=Path(tempfile.mkdtemp(prefix='nexai-whatsapp-515-',dir='/var/backups'))
        os.chmod(backup_dir,0o700)
        backup=backup_dir/'server.mjs'
        shutil.copy2(SERVER,backup)
        original=SERVER.stat()
        os.chmod(tmp,stat.S_IMODE(original.st_mode))
        os.chown(tmp,original.st_uid,original.st_gid)
        try:
            os.replace(tmp,SERVER)
            run('systemctl','restart',UNIT)
            good=False
            for attempt in range(15):
                time.sleep(2)
                if healthy():
                    good=True
                    break
            if not good:raise RuntimeError('Post-deploy server health gate failed')
            if not AUTH.is_file():raise RuntimeError('Stored WhatsApp session disappeared')
            print('DEPLOYED=1 SESSION_FILE_PRESERVED=1 ADMIN_ACCESS_PROTECTED=1',flush=True)
        except Exception:
            shutil.copy2(backup,SERVER)
            run('systemctl','restart',UNIT,check=False)
            print('ROLLBACK=restored_original_server',flush=True)
            raise
    finally:
        tmp.unlink(missing_ok=True)

if __name__=='__main__':
    main()
