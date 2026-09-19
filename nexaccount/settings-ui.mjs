import { tr } from './i18n.mjs';

const utf16len=s=>Buffer.from(String(s),'utf16le').length/2;

export function settingsModel(settings={}){
  const lang=settings.language==='en'?'en':'fr';
  const text=[
    'NEXAI · '+tr(lang,'settings_title'),
    '',
    tr(lang,'language')+' : '+(lang==='fr'?tr(lang,'language_fr'):tr(lang,'language_en')),
    '',
    tr(lang,'powered')
  ].join('\n');
  return {
    text,
    entities:[{type:'expandable_blockquote',offset:0,length:utf16len(text)}],
    reply_markup:{inline_keyboard:[
      [
        {text:'Français',callback_data:'settings:lang:fr',style:lang==='fr'?'success':'primary'},
        {text:'English',callback_data:'settings:lang:en',style:lang==='en'?'success':'primary'}
      ],
      [{text:tr(lang,'back'),callback_data:'menu:home',style:'primary'}]
    ]}
  };
}
