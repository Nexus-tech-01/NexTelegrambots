import { createRequire } from 'node:module';
import { addStickerWatermark, removeStickerWatermark, roundSticker, stickerTransformZone } from '../src/sticker-transform.mjs';

const requireFromNexAccount=createRequire(new URL('../../nexaccount/package.json',import.meta.url));
const { createCanvas }=requireFromNexAccount('@napi-rs/canvas');

const bottom=stickerTransformZone('bottom');
if(!bottom || bottom.w < 100 || bottom.h < 20) throw new Error('invalid bottom zone');

const canvas=createCanvas(512,512);
const ctx=canvas.getContext('2d');
ctx.clearRect(0,0,512,512);
ctx.fillStyle='#ffffff';
ctx.fillRect(96,96,320,320);
const png=canvas.toBuffer('image/png');
const source={buffer:png,mime:'image/png'};

const watermarked=await addStickerWatermark(source,{text:'NexStick',opacity:.12,color:'#ffffff',position:'bottom'});
if(watermarked.format!=='static'||watermarked.mime!=='image/webp'||!watermarked.buffer?.length)throw new Error('watermark transform failed');

const rounded=await roundSticker(source);
if(rounded.format!=='static'||!rounded.buffer?.length)throw new Error('round transform failed');

const cleaned=await removeStickerWatermark({buffer:watermarked.buffer,mime:'image/webp'},{zone:'bottom'});
if(cleaned.format!=='static'||!cleaned.buffer?.length)throw new Error('remove watermark transform failed');

console.log(JSON.stringify({ok:true,watermarkBytes:watermarked.buffer.length,roundBytes:rounded.buffer.length,cleanBytes:cleaned.buffer.length}));
