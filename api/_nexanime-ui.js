import {keyboard} from './_nexanime-telegram.js';
import {titleOf,seasonCount,episodeCount} from './_nexanime-franime.js';

export const esc=s=>String(s??'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

export function resultKeyboard(items){
  return keyboard(items.map((a,i)=>[{text:(i+1)+' · '+titleOf(a).slice(0,42),callback_data:'a:'+a.id}]));
}
export function languageKeyboard(id){
  return keyboard([
    [{text:'🇫🇷 VF',callback_data:'l:'+id+':vf'},{text:'🌐 VOSTFR',callback_data:'l:'+id+':vo'}],
    [{text:'◀️ Retour',callback_data:'r:search'}]
  ]);
}
export function seasonsKeyboard(a,lang){
  const rows=[];let row=[];
  for(let i=0;i<seasonCount(a);i++){
    row.push({text:'S'+(i+1),callback_data:'s:'+a.id+':'+lang+':'+i});
    if(row.length===4){rows.push(row);row=[]}
  }
  if(row.length)rows.push(row);
  rows.push([{text:'◀️ Langue',callback_data:'a:'+a.id}]);
  return keyboard(rows);
}
export function episodesKeyboard(a,lang,s,page=0){
  const total=episodeCount(a,s),per=20,pages=Math.max(1,Math.ceil(total/per));
  page=Math.max(0,Math.min(page,pages-1));
  const rows=[];let row=[];
  for(let i=page*per;i<Math.min(total,(page+1)*per);i++){
    row.push({text:'E'+String(i+1).padStart(2,'0'),callback_data:'e:'+a.id+':'+lang+':'+s+':'+i});
    if(row.length===5){rows.push(row);row=[]}
  }
  if(row.length)rows.push(row);
  const nav=[];
  if(page>0)nav.push({text:'◀️',callback_data:'p:'+a.id+':'+lang+':'+s+':'+(page-1)});
  nav.push({text:(page+1)+'/'+pages,callback_data:'noop'});
  if(page<pages-1)nav.push({text:'▶️',callback_data:'p:'+a.id+':'+lang+':'+s+':'+(page+1)});
  rows.push(nav,[{text:'◀️ Saisons',callback_data:'l:'+a.id+':'+lang}]);
  return keyboard(rows);
}
export function qualityKeyboard(id,lang,s,e){
  return keyboard([
    [360,480,720].map(q=>({text:q+'p',callback_data:'q:'+id+':'+lang+':'+s+':'+e+':'+q})),
    [{text:'◀️ Épisodes',callback_data:'s:'+id+':'+lang+':'+s}]
  ]);
}
