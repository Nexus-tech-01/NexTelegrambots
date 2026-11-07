#!/usr/bin/env python3
"""Append-only OIDC control-plane audit mirror; no command output or credentials.

The GitHub OIDC workflow verifies an owner-authored issue before executing root
operations. This importer mirrors *verified bridge operations* to the NexControl
identity registry as technical service events. The source alone does not prove
ChatGPT authored the original instruction.
"""
from __future__ import annotations
import argparse
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
from account_store import AccountStore, IdentityError

DEFAULT_SOURCE=Path("/var/lib/nxc-oidc-vps/audit.sqlite3")
DEFAULT_DEST=Path("/var/lib/nexcontrol-identity/accounts.sqlite3")
PROVIDER="github-oidc-workflow"
SUBJECT="Tresor562/Nexus-lab/.github/workflows/nxc-vps-commands.yml@refs/heads/main#actor_id=232972883"

def sync_once(source: Path, target: Path):
    if not source.is_file():
        raise FileNotFoundError("OIDC audit database unavailable")
    store=AccountStore(target)
    binding=store.resolve_external(PROVIDER,SUBJECT)
    if not binding or binding["username"]!="chatgpt" or binding["role"]!="service_root":
        raise IdentityError("verified_oidc_principal_binding_missing")
    with closing(sqlite3.connect(f"file:{source}?mode=ro",uri=True,timeout=10)) as origin:
        origin.row_factory=sqlite3.Row
        records=origin.execute(
            "SELECT issue,created,action,state FROM operations ORDER BY created ASC,issue ASC"
        ).fetchall()
    added=0
    for x in records:
        action=str(x["action"])[:80]
        state=str(x["state"])[:32]
        correlation_id="github-issue-"+str(int(x["issue"]))
        # Never copy request bodies, command output, IPs, keys or SSH credentials.
        with closing(store._connect()) as conn:
            exists=conn.execute("""
                SELECT 1 FROM events
                 WHERE actor=? AND channel='github-oidc' AND action=?
                   AND outcome=? AND correlation_id=? LIMIT 1
            """,(binding["id"],action,state,correlation_id)).fetchone()
        if exists:
            continue
        store.record(
            binding["id"],"github-oidc",action,state,
            reason="verified-owner-workflow",
            correlation_id=correlation_id,
            timestamp=int(x["created"])
        )
        added+=1
    return {"scanned":len(records),"added":added}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--source",type=Path,default=DEFAULT_SOURCE)
    parser.add_argument("--identity-db",type=Path,default=DEFAULT_DEST)
    args=parser.parse_args()
    summary=sync_once(args.source,args.identity_db)
    print("OIDC_AUDIT_SYNC_OK scanned="+str(summary["scanned"])+" added="+str(summary["added"]))

if __name__=="__main__":
    sys.exit(main())
