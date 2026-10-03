import { stickerTransformZone } from '../src/sticker-transform.mjs';

const bottom=stickerTransformZone('bottom');
if(!bottom || bottom.w < 100 || bottom.h < 20) throw new Error('invalid bottom zone');
const custom=stickerTransformZone('10,20,100,80');
if(custom.x!==10 || custom.y!==20 || custom.w!==100 || custom.h!==80) throw new Error('invalid custom zone');
console.log('NexStick smoke OK');
