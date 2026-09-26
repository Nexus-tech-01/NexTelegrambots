import { Api } from 'teleproto';
import { cfg } from './config.mjs';

const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;
const clean=v=>String(v??'').trim();

export function brandedText(value,{signature=true}={}){
  const base=String(value??'');
  if(!signature||!cfg.nextechUrl)return {text:base,entities:[]};
  const label='By Nextech';
  const cleanBase=base.replace(/\s+$/,'');
  const text=(cleanBase?cleanBase+'\n\n':'')+label;
  const start=text.lastIndexOf(label);
  return {
    text,
    entities:[new Api.MessageEntityTextUrl({
      offset:utf16len(text.slice(0,start)),
      length:utf16len(label),
      url:cfg.nextechUrl
    })]
  };
}

export async function sendBrandedText(client,peer,value,options={}){
  const branded=brandedText(value,{signature:options.signature!==false});
  const formattingEntities=[
    ...(Array.isArray(options.formattingEntities)?options.formattingEntities:[]),
    ...branded.entities
  ];
  return client.sendMessage(peer,{
    message:branded.text,
    ...options,
    formattingEntities
  });
}

export async function createProgress(client,peer,label='Traitement'){
  const sent=await client.sendMessage(peer,{message:'⏳ '+clean(label)+'…'});
  const id=Number(sent?.id||sent?.message?.id||0);
  let inputPeer=null;
  try{inputPeer=await client.getInputEntity(peer)}catch{}
  const edit=async text=>{
    if(!id||!inputPeer)return;
    try{
      await client.invoke(new Api.messages.EditMessage({
        peer:inputPeer,id,message:String(text)
      }));
    }catch{}
  };
  const state={finished:false};
  return {
    id,
    get finished(){return state.finished},
    update:text=>edit(String(text)),
    step:text=>edit('⏳ '+String(text)),
    async done(text){
      state.finished=true;
      await edit('✅ '+String(text||label+' terminé'));
    },
    async fail(text){
      state.finished=true;
      await edit('❌ '+String(text||label+' impossible'));
    }
  };
}

export function nextechInlineButton(text='NEXTECH'){
  return cfg.nextechUrl?{text:String(text),url:cfg.nextechUrl}:null;
}
