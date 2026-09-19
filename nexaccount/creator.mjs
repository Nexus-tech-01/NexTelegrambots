import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;

export function creatorImagePath(){
  return cfg.creatorImagePath || path.join(HERE,'assets','creator.jpg');
}

export function creatorCaptionModel(language='fr'){
  const lang=String(language||'fr').toLowerCase().startsWith('en')?'en':'fr';
  const lines=lang==='en'
    ? [
      '♰ ɴᴇxᴀɪ • ᴏʀɪɢɪɴ','',
      cfg.creatorDisplayName,'',
      '⌁ ғᴏᴜɴᴅᴇʀ • ѕʏѕᴛᴇᴍѕ ᴀʀᴄʜɪᴛᴇᴄᴛ',
      '   ɴᴇxᴛᴇᴄʜ','',
      '◈ ɴᴇxᴀɪ / ɴᴇxᴜѕ ᴇᴄᴏѕʏѕᴛᴇᴍ',
      '   ᴀɪ • ᴄʏʙᴇʀѕᴇᴄᴜʀɪᴛʏ • ᴀᴜᴛᴏᴍᴀᴛɪᴏɴ','',
      '〝 ᴅᴇѕɪɢɴ. ᴄᴏɴɴᴇᴄᴛ. ᴀᴜᴛᴏᴍᴀᴛᴇ. 〞','',
      '♰ ɴᴇxᴛᴇᴄʜ • ᴘʀᴏᴊᴇᴄᴛѕ & ᴜᴘᴅᴀᴛᴇѕ'
    ]
    : [
      '♰ ɴᴇxᴀɪ • ᴏʀɪɢɪɴ','',
      cfg.creatorDisplayName,'',
      '⌁ ғᴏɴᴅᴀᴛᴇᴜʀ • ᴀʀᴄʜɪᴛᴇᴄᴛᴇ ѕʏѕᴛèᴍᴇѕ',
      '   ɴᴇxᴛᴇᴄʜ','',
      '◈ ɴᴇxᴀɪ / éᴄᴏѕʏѕᴛèᴍᴇ ɴᴇxᴜѕ',
      '   ɪᴀ • ᴄʏʙᴇʀѕéᴄᴜʀɪᴛé • ᴀᴜᴛᴏᴍᴀᴛɪѕᴀᴛɪᴏɴ','',
      '〝 ᴄᴏɴᴄᴇᴠᴏɪʀ. ʀᴇʟɪᴇʀ. ᴀᴜᴛᴏᴍᴀᴛɪѕᴇʀ. 〞','',
      '♰ ɴᴇxᴛᴇᴄʜ • ᴘʀᴏᴊᴇᴛѕ & ᴜᴘᴅᴀᴛᴇѕ'
    ];
  const text=lines.join('\n');
  const nameStart=text.indexOf(cfg.creatorDisplayName);
  const channelLabel=lines.at(-1);
  const channelStart=text.lastIndexOf(channelLabel);
  const entities=[
    {type:'expandable_blockquote',offset:0,length:utf16len(text)},
    {type:'text_link',offset:utf16len(text.slice(0,nameStart)),length:utf16len(cfg.creatorDisplayName),url:cfg.creatorUrl},
    {type:'text_link',offset:utf16len(text.slice(0,channelStart)),length:utf16len(channelLabel),url:cfg.nextechUrl}
  ];
  return {text,entities,language:lang};
}

export function creatorCaptionHtml(language='fr'){
  const model=creatorCaptionModel(language);
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let body=esc(model.text);
  body=body.replace(esc(cfg.creatorDisplayName),'<a href="'+cfg.creatorUrl+'">'+esc(cfg.creatorDisplayName)+'</a>');
  const label=model.language==='en'?'♰ ɴᴇxᴛᴇᴄʜ • ᴘʀᴏᴊᴇᴄᴛѕ & ᴜᴘᴅᴀᴛᴇѕ':'♰ ɴᴇxᴛᴇᴄʜ • ᴘʀᴏᴊᴇᴛѕ & ᴜᴘᴅᴀᴛᴇѕ';
  body=body.replace(esc(label),'<a href="'+cfg.nextechUrl+'">'+esc(label)+'</a>');
  return '<blockquote expandable>'+body+'</blockquote>';
}
