#!/usr/bin/env python3
"""Idempotently add an independent Supabase heartbeat loop to NexForge Host Agent."""
from pathlib import Path
from datetime import datetime, timezone
import py_compile

p=Path("/opt/nexforge-host-agent/agent.py")
s=p.read_text()
if "async def heartbeat_loop():" not in s:
    backup=p.with_name("agent.py.pre-heartbeat-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")+".bak")
    backup.write_text(s)
    marker="async def poll_loop():\n"
    helper='''async def heartbeat_loop():
    while True:
        try:
            await asyncio.to_thread(rpc,"nxf_host_heartbeat",{"p_agent_id":AGENT_ID,"p_agent_key":AGENT_KEY,"p_meta":meta()})
        except Exception as e:
            print("heartbeat error:",e,flush=True)
        await asyncio.sleep(5)

'''
    if marker not in s:
        raise SystemExit("poll_loop anchor missing")
    s=s.replace(marker,helper+marker,1)
    s=s.replace("await asyncio.gather(poll_loop(),tunnel_loop())","await asyncio.gather(poll_loop(),heartbeat_loop(),tunnel_loop())",1)
    s=s.replace("        await poll_loop()","        await asyncio.gather(poll_loop(),heartbeat_loop())",1)
    s=s.replace('VERSION="1.1.0"','VERSION="1.2.0"',1)
    p.write_text(s)
py_compile.compile(str(p),doraise=True)
print("heartbeat_patch_ok")
