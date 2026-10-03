import { Api } from 'teleproto';
import { getInputChannel } from 'teleproto/Utils.js';
import { returnBigInt } from 'teleproto/Helpers.js';

const CACHE_TITLE='NexAI · Internal Cache';
const CACHE_ABOUT='Private NexAI media cache. Used only to accelerate automatic reply video notes.';

export function replyHotCachePeer(configured={}){
  const channelId=String(configured?.hotCacheChannelId||'').trim();
  const accessHash=String(configured?.hotCacheAccessHash||'').trim();
  if(!channelId||!accessHash)return null;
  return new Api.InputChannel({
    channelId:returnBigInt(channelId),
    accessHash:returnBigInt(accessHash)
  });
}

export async function ensureReplyHotCacheChannel(client,configured={}){
  const existing=replyHotCachePeer(configured);
  if(existing){
    try{
      await client.invoke(new Api.channels.GetChannels({id:[existing]}));
      return {
        peer:existing,
        ref:{
          hotCacheChannelId:String(configured.hotCacheChannelId),
          hotCacheAccessHash:String(configured.hotCacheAccessHash)
        },
        created:false
      };
    }catch{}
  }

  const created=await client.invoke(new Api.channels.CreateChannel({
    title:CACHE_TITLE,
    about:CACHE_ABOUT,
    broadcast:true
  }));
  const chat=(created?.chats||[]).find(row=>row?.id!=null&&row?.accessHash!=null);
  if(!chat)throw new Error('canal cache NexAI impossible à créer');
  const peer=getInputChannel(chat);

  // Keep the internal cache out of the main chat list.
  try{
    const inputPeer=new Api.InputPeerChannel({
      channelId:chat.id,
      accessHash:chat.accessHash
    });
    await client.invoke(new Api.folders.EditPeerFolders({
      folderPeers:[new Api.InputFolderPeer({peer:inputPeer,folderId:1})]
    }));
  }catch{}

  return {
    peer,
    ref:{
      hotCacheChannelId:String(chat.id),
      hotCacheAccessHash:String(chat.accessHash)
    },
    created:true
  };
}
