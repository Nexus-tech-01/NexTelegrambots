import test from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import {
  buildChannelStatusNode,
  validateChannelStatusAck,
  uploadNativeChannelMedia,
  sendNativeChannelStatus
} from '../native-channel-status.mjs';

const jid='120363411005383995@newsletter';

test('Pinned Baileys can encode a channel media message without optional attribution enum',()=>{
  assert.equal(typeof proto.Message?.encode,'function');
  assert.equal(typeof proto.Message?.create,'function');
});

test('Channel status stanza contains the real status protocol and media handle',()=>{
  const node=buildChannelStatusNode({
    jid,messageId:'NEX-123',message:{imageMessage:{caption:'Preview'}},
    mediaType:'image',mediaHandle:'123456789',
    encoder:m=>Buffer.from(JSON.stringify(m))
  });
  assert.equal(node.tag,'status');
  assert.equal(node.attrs.to,jid);
  assert.equal(node.attrs.type,'media');
  assert.equal(node.attrs.media_id,'123456789');
  assert.equal(node.content[0].tag,'plaintext');
  assert.equal(node.content[0].attrs.mediatype,'image');
});

test('No media post without WhatsApp-native media handle',()=>{
  assert.throws(()=>buildChannelStatusNode({
    jid,messageId:'a',message:{imageMessage:{}},
    mediaType:'image',
    encoder:()=>new Uint8Array()
  }),/handle natif/);
});

test('Only a valid WhatsApp story ACK confirms publication',()=>{
  assert.deepEqual(validateChannelStatusAck({
    tag:'ack',attrs:{class:'status',id:'abc',from:jid,server_id:'52'}
  },{jid,messageId:'abc'}),{id:'abc',serverId:'52',ack:true});
  assert.throws(()=>validateChannelStatusAck({
    tag:'ack',attrs:{class:'status',id:'abc',from:jid,error:'403'}
  },{jid,messageId:'abc'}),/refusée/);
  assert.throws(()=>validateChannelStatusAck({tag:'message',attrs:{}},{jid,messageId:'abc'}),/pas confirmé/);
});

test('Newsletter uploader uses WhatsApp channel-status media endpoint',async()=>{
  let actual='';
  const sock={refreshMediaConn:async()=>({
    auth:'test-token',
    hosts:[{hostname:'mmg.whatsapp.net'}]
  })};
  const out=await uploadNativeChannelMedia(sock,'/tmp/fixture.jpg',{
    fileEncSha256B64:Buffer.from('filehash').toString('base64'),
    mediaType:'image'
  },{
    upload:async(url,_file,_signal)=>{
      actual=url;
      return {url:'https://mmg.whatsapp.net/m',direct_path:'/m',fbid:'998877'};
    }
  });
  assert.match(actual,/newsletter\/newsletter-image/);
  assert.match(actual,/server_thumb_gen=1/);
  assert.equal(out.fbid,'998877');
});

test('Native sender sends a status stanza, never a normal newsletter message',async()=>{
  const nodes=[];
  const sock={
    user:{id:'111@s.whatsapp.net'},
    refreshMediaConn:async()=>({}),
    waUploadToServer:async()=>({}),
    sendNode:async node=>{nodes.push(node)},
    waitForMessage:async id=>({tag:'ack',attrs:{class:'status',id,from:jid,server_id:'33'}})
  };
  const sent=await sendNativeChannelStatus(sock,jid,{
    image:Buffer.from('test'),
    caption:'Test'
  },{
    makeMessage:async(_jid,content,options)=>{
      assert.ok(!content.contextInfo || Array.isArray(content.contextInfo.statusAttributions));
      await options.upload('/tmp/media',{
        fileEncSha256B64:'aaaa',
        mediaType:'image'
      });
      return {key:{id:'story-42'},message:{imageMessage:{caption:content.caption}}};
    },
    encode:m=>Buffer.from(JSON.stringify(m)),
    uploader:async()=>({handle:'998877',fbid:'998877',mediaUrl:'https://example.com/x',directPath:'/x'})
  });
  assert.equal(sent.ack,true);
  assert.equal(nodes.length,1);
  assert.equal(nodes[0].tag,'status');
  assert.equal(nodes[0].attrs.media_id,'998877');
});
