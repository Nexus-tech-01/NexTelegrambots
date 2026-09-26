import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { prepareTelegramMedia, sendTelegramMedia } from '../media-send.mjs';

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
const fakeClient={
  async sendFile(peer,options){
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
await sendTelegramMedia(fakeClient,'peer',png,{fileName:'photo.jpg',mimeType:'image/jpeg',kind:'image'});
await assert.rejects(access(usedPath));

console.log('media-send regression tests: ok');
