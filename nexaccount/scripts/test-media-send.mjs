import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { normalizeTransferPercent, prepareTelegramMedia, sendTelegramMedia } from '../media-send.mjs';

const png=Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
  0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52
]);
const p=prepareTelegramMedia(png,{fileName:'image.bin',mimeType:'application/octet-stream'});
assert.equal(p.kind,'image');
assert.equal(p.mimeType,'image/png');
assert.equal(p.fileName,'image.png');

const mp3=prepareTelegramMedia(Buffer.from('ID3test'),{fileName:'tts.bin'});
assert.equal(mp3.kind,'audio');
assert.equal(mp3.mimeType,'audio/mpeg');
assert.equal(mp3.fileName,'tts.mp3');

const m4aHeader=Buffer.alloc(16);
m4aHeader.write('ftyp',4,'ascii');
m4aHeader.write('M4A ',8,'ascii');
const m4a=prepareTelegramMedia(m4aHeader,{fileName:'audio.mp4',mimeType:'audio/mp4'});
assert.equal(m4a.kind,'audio');
assert.equal(m4a.mimeType,'audio/mp4');
assert.equal(m4a.fileName,'audio.m4a');

const mp4Header=Buffer.alloc(24);
mp4Header.writeUInt32BE(24,0);
mp4Header.write('ftyp',4,'ascii');
mp4Header.write('isom',8,'ascii');

const validVideoNoteFixture=Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAM3bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAmJ0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKAAAABaAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAAAAABAAAAAAHabWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABhW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAUVzdGJsAAAAuXN0c2QAAAAAAAAAAQAAAKlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAKAAWgBIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAL2F2Y0MBQsAL/+EAGGdCwAvaCjfkwEQAAAMABAAAAwDIPFCqgAEABGjOD8gAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAABtYAAAAAAAAAAYc3R0cwAAAAAAAAABAAAABQAAAgAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAABQAAAAEAAAAoc3RzegAAAAAAAAAAAAAABQAAApQAAAAKAAAACgAAAAoAAAAKAAAAFHN0Y28AAAAAAAAAAQAAA2cAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYxLjcuMTAzAAAACGZyZWUAAALEbWRhdAAAAlQGBf//UNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0xIGRlYmxvY2s9MDowOjAgYW5hbHlzZT0wOjAgbWU9ZGlhIHN1Ym1lPTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMiBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTAgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9MCB0aHJlYWRzPTMgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MjUgc2NlbmVjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcmM9Y3JmIG1idHJlZT0wIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTAAgAAAADhliIQ6JigACQLJycnJycnJycnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXgAAAAZBmiAugewAAAAGQZpAMoHsAAAABkGaYDKB7AAAAAZBmoAygew=','base64');
const mp4=prepareTelegramMedia(mp4Header,{fileName:'tiktok.bin',mimeType:'application/octet-stream'});
assert.equal(mp4.kind,'video');
assert.equal(mp4.mimeType,'video/mp4');
assert.equal(mp4.fileName,'tiktok.mp4');

const pngDeclaredVideo=prepareTelegramMedia(png,{fileName:'wrong.mp4',mimeType:'video/mp4',kind:'video'});
assert.equal(pngDeclaredVideo.kind,'image');
assert.equal(pngDeclaredVideo.mimeType,'image/png');
assert.equal(pngDeclaredVideo.fileName,'wrong.png');

const fakeApk=Buffer.from([0x50,0x4b,0x03,0x04,0,0,0,0]);
const apk=prepareTelegramMedia(fakeApk,{fileName:'app.apk',mimeType:'application/vnd.android.package-archive',kind:'document'});
assert.equal(apk.kind,'document');
assert.equal(apk.mimeType,'application/vnd.android.package-archive');
assert.equal(apk.fileName,'app.apk');

assert.throws(
  ()=>prepareTelegramMedia(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3'),{
    fileName:'tiktok.mp4',
    mimeType:'video/mp4'
  }),
  /playlist/
);

assert.throws(
  ()=>prepareTelegramMedia(Buffer.from('<!doctype html><html>blocked</html>'),{
    fileName:'tiktok.mp4',
    mimeType:'video/mp4'
  }),
  /page\/erreur/
);

let usedPath='';
let afterSendCalled=false;
assert.equal(normalizeTransferPercent(0.42),42);
assert.equal(normalizeTransferPercent(42),42);
assert.equal(normalizeTransferPercent(42,100),42);
assert.equal(normalizeTransferPercent(512,1024),50);
assert.equal(normalizeTransferPercent('bad'),null);

let uploadedPercent=-1;
const fakeClient={
  async sendFile(peer,options){
    if(typeof options.progressCallback==='function')await options.progressCallback(512,1024);
    usedPath=options.file;
    const body=await readFile(options.file);
    assert.equal(peer,'peer');
    assert.equal(body.compare(png),0);
    assert.equal(options.forceDocument,false);
    assert.equal(options.caption,'By Nextech');
    assert.equal(options.formattingEntities.length,1,'media caption must contain the clickable Nextech text-link entity');
    return {ok:true,file:options.file};
  }
};
await sendTelegramMedia(fakeClient,'peer',png,{fileName:'photo.jpg',mimeType:'image/jpeg',kind:'image',afterSend:()=>{afterSendCalled=true;}});
assert.equal(afterSendCalled,true,'media afterSend CTA hook must run after a successful upload');
await assert.rejects(access(usedPath));

let roundVideoNoteSeen=false;
const fakeVideoClient={
  async sendFile(peer,options){
    assert.equal(peer,'peer');
    const normalized=await readFile(options.file);
    assert.ok(normalized.length>0,'video note transcode must produce an MP4');
    assert.equal(options.fileName,'nexai-video-note.mp4');
    assert.equal(options.videoNote,false,'Teleproto videoNote helper must be bypassed');
    const attrs=Array.isArray(options.attributes)?options.attributes:[];
    const video=attrs.find(a=>String(a?.className||a?.constructor?.name||'')==='DocumentAttributeVideo');
    const audio=attrs.find(a=>String(a?.className||a?.constructor?.name||'')==='DocumentAttributeAudio');
    roundVideoNoteSeen=video?.roundMessage===true;
    assert.equal(audio,undefined,'round video note must not carry a voice-note audio attribute');
    assert.equal(video?.w,video?.h,'round video note metadata must be square');
    return {ok:true};
  }
};
await sendTelegramMedia(fakeVideoClient,'peer',validVideoNoteFixture,{
  fileName:'reply.mp4',
  mimeType:'video/mp4',
  kind:'video',
  videoNote:true,
  signature:false
});
assert.equal(roundVideoNoteSeen,true,'Telegram DocumentAttributeVideo.roundMessage must be true');

console.log('media-send regression tests: ok');
