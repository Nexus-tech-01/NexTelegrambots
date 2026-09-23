#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, re, time
from collections import defaultdict
from pathlib import Path

CLK=os.sysconf(os.sysconf_names['SC_CLK_TCK'])
PAGES=os.sysconf('SC_PAGE_SIZE')
SAFE_ROOTS=('/opt/nex','/var/lib/nex','/home/container')

def read_text(path):
    try:
        return Path(path).read_text(errors='replace')
    except Exception:
        return ''

def read_bytes(path):
    try:
        return Path(path).read_bytes()
    except Exception:
        return b''

def proc_row(pid:int):
    stat=read_text(f'/proc/{pid}/stat')
    if not stat:
        return None
    try:
        # comm may contain spaces inside parentheses; split after the last ') '.
        tail=stat.rsplit(') ',1)[1].split()
        ppid=int(tail[1])
        utime=int(tail[11]); stime=int(tail[12])
        rss_pages=int(tail[21])
        rss=max(0,rss_pages*PAGES)
    except Exception:
        return None

    comm=read_text(f'/proc/{pid}/comm').strip()[:80]
    try:
        cwd=os.readlink(f'/proc/{pid}/cwd')
    except Exception:
        cwd=''

    raw=read_bytes(f'/proc/{pid}/cmdline')
    args=[x.decode('utf-8','replace') for x in raw.split(b'\0') if x]
    script=''
    for arg in args[1:4]:
        if re.search(r'\.(?:m?js|cjs|py|sh)$',arg,re.I):
            script=os.path.basename(arg)[:120]
            break

    cgroup=read_text(f'/proc/{pid}/cgroup')
    unit=''
    m=re.search(r'/([^/\n]+\.service)(?:/|$)',cgroup)
    if m:
        unit=m.group(1)[:160]

    relevant=bool(unit.startswith('nex') or any(cwd.startswith(root) for root in SAFE_ROOTS))
    if not relevant:
        # Old orchestrators can have an unhelpful cwd; a script basename is safe to
        # inspect without printing command arguments or environment values.
        relevant=bool(re.search(r'^(?:nex|orchestrator|fleet|watcher|stacy)',script,re.I))
    if not relevant:
        return None

    key=unit or (cwd.rstrip('/') if cwd else '') or script or comm or str(pid)
    return {
        'pid':pid,'ppid':ppid,'comm':comm,'cwd':cwd,'script':script,'unit':unit,
        'rss_bytes':rss,'cpu_ticks':utime+stime,'key':key
    }

def snapshot():
    rows=[]
    try:
        names=os.listdir('/proc')
    except Exception:
        return rows
    for name in names:
        if name.isdigit():
            row=proc_row(int(name))
            if row:
                rows.append(row)
    return rows

def human_mb(v):
    return round(v/1024/1024,1)

def main():
    ap=argparse.ArgumentParser(description='Profile Nexus runtime RAM/CPU without exposing command arguments or secrets.')
    ap.add_argument('--duration',type=int,default=60,help='sample duration in seconds (default 60)')
    ap.add_argument('--interval',type=float,default=5.0,help='seconds between samples (default 5)')
    ap.add_argument('--output',default='',help='optional JSON report path')
    args=ap.parse_args()
    duration=max(1,min(args.duration,3600))
    interval=max(0.5,min(args.interval,60.0))

    started=time.time()
    end=started+duration
    agg=defaultdict(lambda:{
        'samples':0,'max_rss_bytes':0,'sum_rss_bytes':0,'max_cpu_percent':0.0,
        'pids':set(),'comm':set(),'cwd':set(),'script':set(),'unit':set()
    })
    previous={}

    while True:
        now=time.time()
        rows=snapshot()
        for row in rows:
            a=agg[row['key']]
            a['samples']+=1
            a['max_rss_bytes']=max(a['max_rss_bytes'],row['rss_bytes'])
            a['sum_rss_bytes']+=row['rss_bytes']
            a['pids'].add(row['pid'])
            for field in ('comm','cwd','script','unit'):
                if row[field]: a[field].add(row[field])

            prev=previous.get(row['pid'])
            if prev and now>prev['time'] and row['cpu_ticks']>=prev['ticks']:
                cpu=((row['cpu_ticks']-prev['ticks'])/CLK)/(now-prev['time'])*100.0
                a['max_cpu_percent']=max(a['max_cpu_percent'],cpu)
            previous[row['pid']]={'ticks':row['cpu_ticks'],'time':now}

        if now>=end:
            break
        time.sleep(min(interval,max(0.0,end-now)))

    services=[]
    for key,a in agg.items():
        services.append({
            'key':key,
            'samples':a['samples'],
            'max_rss_mb':human_mb(a['max_rss_bytes']),
            'avg_sample_rss_mb':human_mb(a['sum_rss_bytes']/max(1,a['samples'])),
            'max_cpu_percent':round(a['max_cpu_percent'],1),
            'pids':sorted(a['pids']),
            'comm':sorted(a['comm']),
            'cwd':sorted(a['cwd']),
            'script':sorted(a['script']),
            'unit':sorted(a['unit'])
        })
    services.sort(key=lambda x:x['max_rss_mb'],reverse=True)

    report={
        'created_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
        'duration_seconds':round(time.time()-started,1),
        'interval_seconds':interval,
        'privacy_note':'No full command line, environment value, token, password or URI is collected.',
        'service_count':len(services),
        'services':services,
        'sum_of_service_peak_rss_mb':round(sum(x['max_rss_mb'] for x in services),1)
    }

    out=json.dumps(report,indent=2)
    if args.output:
        p=Path(args.output)
        p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(out+'\n')
        try: os.chmod(p,0o600)
        except Exception: pass
        print('Report written:',p)
    print('\nRuntime footprint summary')
    print('samples duration:',report['duration_seconds'],'s')
    print('services:',len(services))
    print('sum of individual peak RSS:',report['sum_of_service_peak_rss_mb'],'MiB')
    print()
    print(f"{'peak MiB':>10} {'CPU%':>8}  service/runtime")
    for x in services[:40]:
        print(f"{x['max_rss_mb']:>10.1f} {x['max_cpu_percent']:>8.1f}  {x['key']}")

if __name__=='__main__':
    main()
