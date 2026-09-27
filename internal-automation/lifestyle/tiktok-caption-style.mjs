const clean=v=>String(v??'').trim();

function mathSansBold(value,{upper=false}={}){
  const raw=(upper?clean(value).toLocaleUpperCase('fr-FR'):String(value??'')).normalize('NFD');
  let out='';
  for(const ch of raw){
    const cp=ch.codePointAt(0);
    if(cp>=65&&cp<=90)out+=String.fromCodePoint(0x1D5D4+cp-65);
    else if(cp>=97&&cp<=122)out+=String.fromCodePoint(0x1D5EE+cp-97);
    else if(cp>=48&&cp<=57)out+=String.fromCodePoint(0x1D7EC+cp-48);
    else out+=ch;
  }
  return out;
}

const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const clip=(value,max)=>Array.from(clean(value)).slice(0,max).join('').trim();

function poemLines(poem){
  let lines=String(poem??'').split(/\r?\n+/).map(x=>clip(x,82)).filter(Boolean);
  if(lines.length<3){
    lines=(String(poem??'').match(/[^.!?…]+[.!?…]?/g)||[]).map(x=>clip(x,82)).filter(Boolean);
  }
  return lines.slice(0,7);
}

function startsFor(n,maxStanzas){
  if(n>=7&&maxStanzas>=3)return [0,Math.ceil(n/3),Math.ceil(2*n/3)];
  if(n>=4&&maxStanzas>=2)return [0,Math.ceil(n/2)];
  return [0];
}

function formatPoem(lines,category){
  const bold=lines.map(x=>mathSansBold(x));
  if(category==='amv_edit'){
    const starts=startsFor(bold.length,3);
    return bold.map((line,i)=>{
      let prefix='';
      if(i===starts[0])prefix='☁️ׄ ︵ ׅ ';
      else if(starts[1]!==undefined&&i===starts[1])prefix='꒰ ꒰ ּ 🌙 ';
      else if(starts[2]!==undefined&&i===starts[2])prefix='☁️ׄ ︵ ׅ ';
      let suffix='';
      if(starts[1]!==undefined&&i===starts[1]-1)suffix=' 🖤';
      if(i===bold.length-1)suffix=' 🥀';
      return prefix+line+suffix;
    }).join('\n');
  }

  const starts=startsFor(bold.length,2);
  return bold.map((line,i)=>{
    let prefix='';
    if(i===0)prefix='☁️ׄ ︵ ׅ ';
    else if(starts[1]!==undefined&&i===starts[1])prefix='꒰ ꒰ ּ 🌃 ';
    const gap=starts[1]!==undefined&&i===starts[1]?'\n':'';
    return gap+prefix+line;
  }).join('\n');
}

function titleOf(analysis,fallback){
  const title=clip(analysis?.title||fallback,42).replace(/[“”"']/g,'').replace(/\s+/g,' ');
  return mathSansBold(title||fallback,{upper:true});
}

function otakuTemplate(analysis){
  const title=titleOf(analysis,'HIDDEN FEELINGS');
  const body=formatPoem(poemLines(analysis?.poem),'amv_edit');
  return [
    'ㅤㅤㅤ︵۪۪۪۪۪᷼͡⏜۪۪۪۪۪᷼͡︵᷼ㅤׄ🪞ㅤ᷼︵۪۪۪۪۪᷼͡⏜۪۪۪۪۪᷼͡︵᷼ㅤ',
    'ׄ 🦋ᩧꫬ   𝗣𝗘𝗡𝗦𝗘́𝗘   𝗗𝗨   𝗝𝗢𝗨𝗥   —   '+title+' ׅ ꒱ ꒱',
    body,
    'ㅤㅤ© ׄ 🪞゙᷼   𝗁𝗂𝖽𝖽𝖾𝗇 𝖿𝖾𝖾𝗅𝗂𝗇𝗀𝗌 ׅ 𖦹᳟',
    'ㅤㅤㅤㅤׄ 𝖻𝗒 𝖳𝗋𝖾́𝗌𝗈𝗋 𖦹᳟'
  ].join('\n');
}

function luxuryTemplate(analysis){
  const title=titleOf(analysis,'AFTER DARK');
  const body=formatPoem(poemLines(analysis?.poem),'luxury_life');
  return [
    'ㅤㅤㅤ︵۪۪۪۪۪᷼͡⏜۪۪۪۪۪᷼͡︵᷼ㅤׄ🌙ㅤ᷼︵۪۪۪۪۪᷼͡⏜۪۪۪۪۪᷼͡︵᷼ㅤ',
    '',
    'ׄ 🥂ᩧꫬ   𝗟𝗨𝗫𝗨𝗥𝗬   𝗟𝗜𝗙𝗘   —   '+title+' ׅ ꒱ ꒱',
    '',
    body,
    '',
    'ㅤㅤ© ׄ 🌙゙᷼   𝖺𝖿𝗍𝖾𝗋 𝖽𝖺𝗋𝗄 ׅ 𖦹᳟',
    '',
    '· · ─ ──────────────── ─ · · 𖢄',
    '',
    'ㅤ𝗌𝗁𝖺𝗋𝖾ㅤㅤㅤㅤ𝖻𝗈𝗈𝗌𝗍',
    'ㅤㅤㅤㅤ𝗂𝗇𝗏𝗂𝗍𝖾ㅤ·ㅤ𝗋𝖾𝖺𝖼𝗍'
  ].join('\n');
}

export function buildStyledCaptions(candidate,analysis){
  const isOtaku=candidate?.source?.category==='amv_edit';
  const template=isOtaku?otakuTemplate(analysis):luxuryTemplate(analysis);
  return {
    plain:template.trim(),
    html:esc(template).trim()
  };
}
