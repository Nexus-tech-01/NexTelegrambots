#!/usr/bin/env python3
"""Repair the NexAnime -> NexCanal staging handoff on the production VPS.

This is intentionally idempotent. It:
1. makes NexCanal extract the deterministic #NEXANIME_STAGE:<24hex> token
   from message/caption updates (including edited/channel-post shapes);
2. keeps the live dist bundle in sync with the TypeScript source;
3. restores the NexAccount anime module group/mode so nex-public can read it.

Run as root on the VPS. Use --restart to restart and health-check both services.
"""
from __future__ import annotations

import argparse
import grp
import os
from pathlib import Path
import shutil
import subprocess
import time

OLD_TS = """  const stagePayload=String(update?.message?.text??update?.message?.caption??'');
  if(stagePayload.startsWith('#NEXANIME_STAGE:')){
    const msg=update?.message;
    const marker=stagePayload.trim();
    const row=await animeHandoffs.findOne({stageMarker:marker,status:{$in:['staging','pending','processing']}}).catch(()=>null);
    if(row&&msg?.message_id){await animeHandoffs.updateOne({_id:row._id},{$set:{sourceMessageId:Number(msg.message_id),fromChatId:String(msg.chat?.id||row.fromChatId),status:'pending',nextAttemptAt:new Date(),updatedAt:new Date()}}).catch(()=>{});}
    return;
  }
"""
NEW_TS = """  const msg=update?.message??update?.edited_message??update?.channel_post??update?.edited_channel_post;
  const stagePayload=String(msg?.text??msg?.caption??'');
  const marker=stagePayload.match(/#NEXANIME_STAGE:[a-f0-9]{24}/i)?.[0]||'';
  if(marker){
    const row=await animeHandoffs.findOne({stageMarker:marker,status:{$in:['staging','pending','processing']}}).catch(()=>null);
    if(row&&msg?.message_id){
      await animeHandoffs.updateOne({_id:row._id},{$set:{sourceMessageId:Number(msg.message_id),fromChatId:String(msg.chat?.id||row.fromChatId),status:'pending',nextAttemptAt:new Date(),updatedAt:new Date()}}).catch(()=>{});
      console.log('[NexAnime/NexCanal stage] matched',String(row.dedupeKey||''),'msg',String(msg.message_id));
    }else{
      console.warn('[NexAnime/NexCanal stage] unmatched',marker,String(msg?.message_id||0));
    }
    return;
  }
"""

OLD_JS = """    const stagePayload = String(update?.message?.text ?? update?.message?.caption ?? '');
    if (stagePayload.startsWith('#NEXANIME_STAGE:')) {
        const msg = update?.message;
        const marker = stagePayload.trim();
        const row = await animeHandoffs.findOne({ stageMarker: marker, status: { $in: ['staging', 'pending', 'processing'] } }).catch(() => null);
        if (row && msg?.message_id) {
            await animeHandoffs.updateOne({ _id: row._id }, { $set: { sourceMessageId: Number(msg.message_id), fromChatId: String(msg.chat?.id || row.fromChatId), status: 'pending', nextAttemptAt: new Date(), updatedAt: new Date() } }).catch(() => { });
        }
        return;
    }
"""
NEW_JS = """    const msg = update?.message ?? update?.edited_message ?? update?.channel_post ?? update?.edited_channel_post;
    const stagePayload = String(msg?.text ?? msg?.caption ?? '');
    const marker = stagePayload.match(/#NEXANIME_STAGE:[a-f0-9]{24}/i)?.[0] || '';
    if (marker) {
        const row = await animeHandoffs.findOne({ stageMarker: marker, status: { $in: ['staging', 'pending', 'processing'] } }).catch(() => null);
        if (row && msg?.message_id) {
            await animeHandoffs.updateOne({ _id: row._id }, { $set: { sourceMessageId: Number(msg.message_id), fromChatId: String(msg.chat?.id || row.fromChatId), status: 'pending', nextAttemptAt: new Date(), updatedAt: new Date() } }).catch(() => { });
            console.log('[NexAnime/NexCanal stage] matched', String(row.dedupeKey || ''), 'msg', String(msg.message_id));
        }
        else {
            console.warn('[NexAnime/NexCanal stage] unmatched', marker, String(msg?.message_id || 0));
        }
        return;
    }
"""


def patch_once(path: Path, old: str, new: str) -> str:
    text = path.read_text()
    if new in text:
        return "already-fixed"
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected old block once, found {count}")
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    shutil.copy2(path, path.with_name(path.name + f".pre-nexanime-handoff-{stamp}"))
    path.write_text(text.replace(old, new, 1))
    return "patched"


def run(*args: str) -> None:
    subprocess.run(args, check=True)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--nexcanal-root", default="/opt/nex/releases/legacy-live-20260924/nexcanal")
    p.add_argument("--nexai-root", default="/opt/nex/apps/public/nexai/current")
    p.add_argument("--restart", action="store_true")
    a = p.parse_args()

    canal = Path(a.nexcanal_root)
    src = canal / "src/main.ts"
    dist = canal / "dist/src/main.js"
    print(src, patch_once(src, OLD_TS, NEW_TS))
    print(dist, patch_once(dist, OLD_JS, NEW_JS))
    run("node", "--check", str(dist))

    anime = Path(a.nexai_root).resolve() / "anime-ingest.mjs"
    daemon = Path(a.nexai_root).resolve() / "daemon.mjs"
    if anime.exists() and daemon.exists():
        target_gid = daemon.stat().st_gid
        os.chown(anime, -1, target_gid)
        os.chmod(anime, 0o640)
        print(anime, f"group={grp.getgrgid(target_gid).gr_name}", "mode=0640")

    if a.restart:
        run("systemctl", "restart", "nex-nexcanal.service")
        time.sleep(15)
        run("systemctl", "restart", "nex-nexaccount.service")
        time.sleep(8)
        run("systemctl", "is-active", "--quiet", "nex-nexcanal.service")
        run("systemctl", "is-active", "--quiet", "nex-nexaccount.service")


if __name__ == "__main__":
    main()
