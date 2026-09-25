import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandMap } from '../commands.mjs';
import { canHandleAiCommand } from '../ai-engine.mjs';
import { canHandleDownloadCommand } from '../dipper-fallback.mjs';
import { canHandleStickerCommand } from '../sticker-engine.mjs';
import { canHandleGameCommand } from '../game-engine.mjs';
import { canHandleAnimeCommand } from '../anime-engine.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.dirname(HERE);
const commands=commandMap();
const errors=[];

function requireCommand(name,checks={}){
  const cmd=commands.get(name);
  if(!cmd){errors.push('missing:'+name);return null}
  for(const [key,value] of Object.entries(checks)){
    if(cmd[key]!==value)errors.push(name+':'+key+' expected '+String(value)+' got '+String(cmd[key]));
  }
  return cmd;
}

for(const name of ['ai','code','deepseek']){
  const cmd=requireCommand(name,{engine:'ai'});
  if(cmd&&!canHandleAiCommand(cmd.aliasFor||cmd.name))errors.push('ai-route:'+name);
}

for(const name of ['song','video','tiktok','instagram','facebook','pinterest','tomp3','lyrics','shazam','apk']){
  const cmd=requireCommand(name,{engine:'download'});
  if(cmd&&!canHandleDownloadCommand(cmd.aliasFor||cmd.name))errors.push('download-route:'+name);
}

for(const name of ['sticker','stickerinfo','clonepack','createpack','mypacks','exportwhatsapp']){
  const cmd=requireCommand(name,{engine:'sticker'});
  if(cmd&&!canHandleStickerCommand(cmd.aliasFor||cmd.name))errors.push('sticker-route:'+name);
}

for(const name of ['riddle','quiz','tictactoe']){
  const cmd=requireCommand(name,{engine:'game',groupOnly:true});
  if(cmd&&!canHandleGameCommand(cmd.aliasFor||cmd.name))errors.push('game-route:'+name);
}

const anime=[...commands.values()].filter(c=>!c.hidden&&c.engine==='anime');
if(anime.length<70)errors.push('anime-surface-too-small:'+anime.length);
for(const cmd of anime){
  if(!canHandleAnimeCommand(cmd.aliasFor||cmd.name))errors.push('anime-route:'+cmd.name);
}

for(const name of ['account','pair','sessions','settings','prefix','mode','language']){
  requireCommand(name,{privateOnly:true,selfOnly:true});
}

for(const name of ['promote','demote','kick','ban','unban','mute','unmute','warn','tagall','hidetag','mediatag','slowmode']){
  requireCommand(name,{engine:'group',groupOnly:true,adminOnly:true});
}
for(const name of ['antilink','antispam','antitag','antigroupmention','antibadword','blacklist','whitelist','risk']){
  requireCommand(name,{engine:'group',groupOnly:true,adminOnly:true});
}
for(const name of ['antiraid','captcha','raidmode','nightmode','logs','autoapprove','autotyping']){
  if(commands.has(name))errors.push('configuration-only-command-exposed:'+name);
}

for(const name of ['tourl','crop','resize','analyzesound','vv']){
  requireCommand(name,{category:'MEDIA'});
}

const runtime=fs.readFileSync(path.join(ROOT,'runtime.mjs'),'utf8');
const compat=fs.readFileSync(path.join(ROOT,'compat.mjs'),'utf8');
const inline=fs.readFileSync(path.join(ROOT,'inline-bot.mjs'),'utf8');
const commandSource=fs.readFileSync(path.join(ROOT,'commands.mjs'),'utf8');
const cliSource=fs.readFileSync(path.join(ROOT,'cli.mjs'),'utf8');
const secondaryAnimeSource=fs.readFileSync(path.join(ROOT,'anime-secondary-reader.mjs'),'utf8');
const daemonSource=fs.readFileSync(path.join(ROOT,'daemon.mjs'),'utf8');
const downloadSource=fs.readFileSync(path.join(ROOT,'dipper-fallback.mjs'),'utf8');
const stickerSource=fs.readFileSync(path.join(ROOT,'sticker-engine.mjs'),'utf8');

for(const marker of [
  "if(parsed.name==='menu')return sendMenu(runtime,peer)",
  "if(cmd.engine==='anime')",
  "if(cmd.engine==='ai')",
  "if(cmd.engine==='download')",
  "if(cmd.engine==='sticker')",
  "if(cmd.engine==='game')",
  'handleCompatCommand'
]){
  if(!runtime.includes(marker))errors.push('runtime-marker:'+marker);
}
if(compat.includes('250 Stars/mois')||compat.includes('NexAi Premium ·'))errors.push('unimplemented-nexai-stars-subscription-advertised');
for(const name of ['waifuhd','cosplayvip','amvhd','openingvip']){
  const cmd=commands.get(name);
  if(cmd?.premium===true)errors.push('anime-command-wrongly-gated-by-telegram-premium:'+name);
}
if(!commandSource.includes("PREMIUM:'TELEGRAM PREMIUM'"))errors.push('telegram-premium-category-label-missing');
if(!secondaryAnimeSource.includes("NEXANIME_SECONDARY_ENABLED"))errors.push('secondary-anime-enabled-guard-missing');
if(!secondaryAnimeSource.includes("reason:'disabled'"))errors.push('secondary-anime-disabled-state-missing');
if(secondaryAnimeSource.includes("||'/home/container/.nexcontrol/nexcanal-reader-session.txt'"))errors.push('legacy-secondary-session-fallback-still-present');
if(!cliSource.includes("case 'command-test':"))errors.push('live-command-diagnostic-cli-missing');
if(!runtime.includes("out:true"))errors.push('diagnostic-command-not-self-authored');
if(!runtime.includes("const {account}=runtime;"))errors.push('diagnostic-command-account-not-bound');
if(!daemonSource.includes('NEXACCOUNT_STARTUP_SMOKE'))errors.push('startup-smoke-flag-missing');
if(!daemonSource.includes('runtimeMenuProbe'))errors.push('startup-smoke-menu-probe-missing');
if(!daemonSource.includes('engineStatus'))errors.push('startup-smoke-engine-status-missing');
if(!daemonSource.includes("mode==='download'"))errors.push('download-startup-smoke-mode-missing');
if(!daemonSource.includes("mode==='health'"))errors.push('health-startup-smoke-mode-missing');
if(!daemonSource.includes("mode==='group'"))errors.push('group-startup-smoke-mode-missing');
if(!runtime.includes('runtimeGroupSmoke'))errors.push('runtime-group-smoke-missing');
if(!runtime.includes('Api.channels.CreateChannel'))errors.push('temporary-group-create-missing');
if(!runtime.includes('Api.channels.DeleteChannel'))errors.push('temporary-group-cleanup-missing');
if(!runtime.includes('getInputChannel(await client.getInputEntity(peer))'))errors.push('runtime-admin-input-channel-conversion-missing');
if(!daemonSource.includes("aqz-KE-bpKQ"))errors.push('download-startup-smoke-fixture-missing');
if(!downloadSource.includes("/opt/nex/tools/yt-dlp/yt-dlp"))errors.push('local-ytdlp-path-missing');
if(!downloadSource.includes("Source : yt-dlp local"))errors.push('local-ytdlp-primary-route-missing');
if(downloadSource.includes('api.yupra.my.id'))errors.push('dead-yupra-provider-still-present');
if(downloadSource.includes('izumiiiiiiii.dpdns.org'))errors.push('dead-izumi-provider-still-present');
if(downloadSource.includes('tiktokH265'))errors.push('obsolete-cobalt-tiktok-option-present');
if(!downloadSource.includes('allowH265:false'))errors.push('current-cobalt-tiktok-option-missing');
if(!stickerSource.includes('stickerEngineDiagnostic'))errors.push('sticker-real-health-probe-missing');
if(!stickerSource.includes("botApi('getMe'"))errors.push('sticker-botapi-reachability-probe-missing');
if(!stickerSource.includes("prepareSticker({buffer:png,mime:'image/png'})"))errors.push('sticker-local-conversion-probe-missing');
if(!runtime.includes('stickerEngineDiagnostic'))errors.push('runtime-sticker-health-not-wired');
if(!runtime.includes('Commande inconnue'))errors.push('unknown-command-response-missing');
if(!runtime.includes('presenceTimer'))errors.push('persistent-presence-heartbeat-missing');
if(!runtime.includes('messageAuthorIsBot(client,message,event?.sender)'))errors.push('auto-moderation-bot-exemption-missing');
if(!runtime.includes('userIsGroupAdmin(client,message.peerId,sender)'))errors.push('auto-moderation-admin-exemption-missing');
if(!inline.includes("bot.command('start'"))errors.push('/start-handler-missing');
if(!inline.includes("bot.command('menu'"))errors.push('/menu-handler-missing');
if(!inline.includes("bot.command('help'"))errors.push('/help-handler-missing');

for(const visible of [...commands.values()].filter(c=>!c.hidden)){
  const route=String(visible.handler||visible.aliasFor||visible.name);
  if(visible.engine)continue;
  if(['menu','ping','alive','account','help','join','leave','style'].includes(route))continue;
  if(!runtime.includes(route)&&!compat.includes(route)){
    errors.push('visible-command-without-local-route-marker:'+visible.name+'->'+route);
  }
}

assert.deepEqual(errors,[],errors.join('\n'));
console.log(JSON.stringify({
  ok:true,
  ai:3,
  downloads:10,
  stickers:6,
  games:3,
  anime:anime.length,
  protections:8,
  accountControls:7,
  noSilentUnknown:true
},null,2));
