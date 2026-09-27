import fs from 'node:fs/promises';

const clean=v=>String(v??'').trim();
const first=(...names)=>{for(const n of names){const v=clean(process.env[n]);if(v)return v}return ''};
const timeoutMs=Math.max(15000,Math.min(120000,Number(process.env.LIFESTYLE_AI_TIMEOUT_MS||60000)));

function promptFor({category,creator,description,duration}){
  const kind=category==='amv_edit'?'AMV / anime edit':'Luxury Life';
  return [
    'Tu analyses une vidéo TikTok destinée à une publication éditoriale.',
    'Catégorie: '+kind+'. Créateur source: @'+creator+'.',
    description?'Description TikTok: '+description.slice(0,800):'',
    duration?'Durée approximative: '+duration+' secondes.':'',
    'Analyse réellement les images, le mouvement et, si disponible, l audio.',
    'Le texte doit correspondre précisément à l ambiance de CETTE vidéo, pas être un poème générique.',
    category==='amv_edit'
      ? 'Si un anime ou un personnage est clairement identifiable, tu peux le nommer. Si tu n es pas sûr, ne l invente pas.'
      : 'Décris seulement les éléments luxury visibles ou fortement suggérés; n invente pas une marque non visible.',
    'Écris ensuite un poème en français de 4 à 7 lignes, naturel, évocateur, chaque ligne restant assez courte pour une publication Telegram. N ajoute aucun titre, aucune signature, aucun hashtag et aucune décoration au poème : le système applique lui-même la mise en page de Trésor.',
    'Évite les clichés répétitifs, les promesses financières et les affirmations factuelles non visibles.',\n    category==='amv_edit'\n      ? 'Le champ title doit être une courte pensée émotionnelle de 2 à 6 mots, sans emoji ni décoration.'\n      : 'Le champ title doit être un titre Luxury très court de 2 à 6 mots, cinématographique; l anglais est permis si naturel. Sans emoji ni décoration.',
    'Retourne UNIQUEMENT un objet JSON valide avec exactement ces clés:',
    '{"summary":"...","mood":["..."],"subjects":["..."],"energy":"calm|medium|high","visual_style":"...","title":"...","poem":"...","hashtags":["..."]}'
  ].filter(Boolean).join('\n');
}

function parseJson(text){
  const raw=clean(text).replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`$/,'');
  const start=raw.indexOf('{'),end=raw.lastIndexOf('}');
  if(start<0||end<=start)throw new Error('AI JSON introuvable');
  const out=JSON.parse(raw.slice(start,end+1));
  const poem=clean(out.poem);
  if(poem.length<40||poem.length>1600)throw new Error('Poème IA invalide');
  return {
    summary:clean(out.summary).slice(0,600),
    mood:Array.isArray(out.mood)?out.mood.map(clean).filter(Boolean).slice(0,8):[],
    subjects:Array.isArray(out.subjects)?out.subjects.map(clean).filter(Boolean).slice(0,10):[],
    energy:['calm','medium','high'].includes(clean(out.energy))?clean(out.energy):'medium',
    visual_style:clean(out.visual_style).slice(0,300),
    title:clean(out.title).slice(0,120),
    poem,
    hashtags:Array.isArray(out.hashtags)?out.hashtags.map(x=>clean(x).replace(/^#/,'')).filter(Boolean).slice(0,8):[]
  };
}

async function fileToB64(path){return Buffer.from(await fs.readFile(path)).toString('base64')}

function visionProviders(){
  const p=[];
  const gemini=first('GEMINI_API_KEY','GOOGLE_AI_API_KEY','NEXAI_GEMINI_API_KEY');
  if(gemini)p.push({kind:'gemini',name:'gemini',key:gemini,model:first('NEXAI_GEMINI_MODEL')||'gemini-2.5-flash'});
  const openai=first('OPENAI_API_KEY','NEXAI_OPENAI_API_KEY');
  if(openai)p.push({kind:'openai',name:'openai',key:openai,base:'https://api.openai.com/v1',model:first('NEXAI_OPENAI_MODEL')||'gpt-4o-mini'});
  const openrouter=first('OPENROUTER_API_KEY','NEXAI_OPENROUTER_API_KEY');
  if(openrouter)p.push({kind:'openai',name:'openrouter',key:openrouter,base:'https://openrouter.ai/api/v1',model:first('NEXAI_OPENROUTER_MODEL')||'openai/gpt-4o-mini',headers:{'HTTP-Referer':'https://t.me/NexAi01_bot','X-Title':'Nex Lifestyle'}});
  return p;
}

async function callGemini(provider,{videoPath,framePaths,prompt}){
  const parts=[{text:prompt}];
  let usedVideo=false;
  if(videoPath){
    const st=await fs.stat(videoPath).catch(()=>null);
    if(st&&st.size>0&&st.size<=15*1024*1024){
      parts.push({inline_data:{mime_type:'video/mp4',data:await fileToB64(videoPath)}});
      usedVideo=true;
    }
  }
  if(!usedVideo){
    for(const p of framePaths.slice(0,6))parts.push({inline_data:{mime_type:'image/jpeg',data:await fileToB64(p)}});
  }
  const url='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(provider.model)+':generateContent';
  const r=await fetch(url,{
    method:'POST',
    headers:{'content-type':'application/json','x-goog-api-key':provider.key},
    body:JSON.stringify({
      contents:[{role:'user',parts}],
      generationConfig:{temperature:0.82,maxOutputTokens:1200,responseMimeType:'application/json'}
    }),
    signal:AbortSignal.timeout(timeoutMs)
  });
  const data=await r.json().catch(()=>null);
  if(!r.ok)throw new Error('gemini HTTP '+r.status+' '+clean(data?.error?.message).slice(0,220));
  const text=clean((data?.candidates?.[0]?.content?.parts||[]).map(x=>x?.text||'').join(''));
  if(!text)throw new Error('gemini réponse vide');
  return {text,mediaMode:usedVideo?'video':'frames'};
}

async function callOpenAi(provider,{framePaths,prompt}){
  if(!framePaths.length)throw new Error(provider.name+' sans frames');
  const content=[{type:'text',text:prompt}];
  for(const p of framePaths.slice(0,6)){
    content.push({type:'image_url',image_url:{url:'data:image/jpeg;base64,'+await fileToB64(p),detail:'low'}});
  }
  const r=await fetch(provider.base.replace(/\/$/,'')+'/chat/completions',{
    method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+provider.key,...(provider.headers||{})},
    body:JSON.stringify({
      model:provider.model,
      messages:[{role:'user',content}],
      temperature:0.82,
      max_tokens:1200
    }),
    signal:AbortSignal.timeout(timeoutMs)
  });
  const data=await r.json().catch(()=>null);
  if(!r.ok)throw new Error(provider.name+' HTTP '+r.status+' '+clean(data?.error?.message||data?.message).slice(0,220));
  const text=clean(data?.choices?.[0]?.message?.content);
  if(!text)throw new Error(provider.name+' réponse vide');
  return {text,mediaMode:'frames'};
}

export function visionProviderStatus(){
  return visionProviders().map(x=>({name:x.name,model:x.model,kind:x.kind}));
}

export async function analyzeTikTokVideo({videoPath,framePaths=[],category,creator,description='',duration=null}){
  const providers=visionProviders();
  if(!providers.length)throw new Error('Aucun moteur vision configuré pour Lifestyle');
  const prompt=promptFor({category,creator,description,duration});
  const errors=[];
  for(const provider of providers){
    try{
      const raw=provider.kind==='gemini'
        ?await callGemini(provider,{videoPath,framePaths,prompt})
        :await callOpenAi(provider,{framePaths,prompt});
      return {...parseJson(raw.text),provider:provider.name,model:provider.model,mediaMode:raw.mediaMode};
    }catch(error){errors.push(String(error?.message||error))}
  }
  throw new Error('Analyse vidéo impossible · '+errors.slice(-3).join(' | '));
}
