import assert from 'node:assert/strict';
import { replyStorageMediaFromMessage } from '../reply-storage.mjs';

for(const key of ['video_note','video','document','animation']){
  const media={file_id:key+'-file',file_unique_id:key+'-unique',file_size:123};
  const message={[key]:media};
  assert.equal(replyStorageMediaFromMessage(message),media,'extract '+key);
}

assert.equal(replyStorageMediaFromMessage({}),null,'empty Telegram message');
assert.equal(replyStorageMediaFromMessage(null),null,'null Telegram message');
console.log('reply storage media tests: ok');
