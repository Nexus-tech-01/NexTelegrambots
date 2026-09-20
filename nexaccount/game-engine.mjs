const STATES=new Map();
const TTL=45*60*1000;

const RIDDLES=[
  {q:'Je peux remplir une pièce sans prendre de place. Qui suis-je ?',a:['lumiere','lumière']},
  {q:'Plus on en prend, plus on en laisse derrière soi. Que sont-elles ?',a:['pas','les pas','empreintes']},
  {q:'Je monte mais je ne descends jamais. Qui suis-je ?',a:['age','âge']},
  {q:'Je possède des villes sans maisons, des forêts sans arbres et de l’eau sans poisson. Qui suis-je ?',a:['carte','une carte']},
  {q:'Qu’est-ce qui a des clés mais n’ouvre aucune porte ?',a:['clavier','piano','un clavier','un piano']},
  {q:'Je suis toujours devant toi mais tu ne peux jamais me voir. Qui suis-je ?',a:['avenir','futur','le futur','l avenir']},
  {q:'Qu’est-ce qui devient plus mouillé à mesure qu’il sèche ?',a:['serviette','une serviette']},
  {q:'Je n’ai ni bouche ni oreilles, pourtant je réponds quand on m’appelle. Qui suis-je ?',a:['echo','écho','un echo','un écho']}
];

const QUIZZES=[
  {q:'Quel est le plus grand océan de la Terre ?',choices:['Atlantique','Pacifique','Indien','Arctique'],a:1},
  {q:'Combien vaut 12 × 8 ?',choices:['84','92','96','108'],a:2},
  {q:'Quel langage s’exécute nativement dans un navigateur web ?',choices:['JavaScript','C','Rust','Go'],a:0},
  {q:'Quelle planète est surnommée la planète rouge ?',choices:['Vénus','Mars','Jupiter','Mercure'],a:1},
  {q:'Quel protocole chiffre normalement une connexion web HTTPS ?',choices:['TLS','FTP','SMTP','DNS'],a:0},
  {q:'Quelle est la capitale du Japon ?',choices:['Osaka','Kyoto','Tokyo','Nagoya'],a:2},
  {q:'Dans le système binaire, 1010 vaut combien en décimal ?',choices:['8','10','12','14'],a:1},
  {q:'Quel composant stocke les données de façon persistante ?',choices:['RAM','Cache CPU','SSD','Registre CPU'],a:2}
];

const clean=v=>String(v??'').trim();
const norm=v=>clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const key=(account,event)=>String(account.telegramUserId)+':'+String(event?.chatId||event?.message?.peerId?.channelId||event?.message?.peerId?.chatId||event?.message?.peerId?.userId||'global');
const random=a=>a[Math.floor(Math.random()*a.length)];

function getState(k){
  const s=STATES.get(k);
  if(s&&Date.now()-s.updatedAt<TTL)return s;
  if(s)STATES.delete(k);
  return null;
}
function setState(k,v){STATES.set(k,{...v,updatedAt:Date.now()})}
function clearState(k){STATES.delete(k)}
setInterval(()=>{
  const now=Date.now();
  for(const [k,v] of STATES)if(now-v.updatedAt>TTL)STATES.delete(k);
},10*60*1000).unref?.();

function boardText(board){
  const cell=i=>board[i]||String(i+1);
  return [
    cell(0)+' │ '+cell(1)+' │ '+cell(2),
    '──┼───┼──',
    cell(3)+' │ '+cell(4)+' │ '+cell(5),
    '──┼───┼──',
    cell(6)+' │ '+cell(7)+' │ '+cell(8)
  ].join('\n');
}
function winner(b){
  const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for(const [a,c,d] of lines)if(b[a]&&b[a]===b[c]&&b[a]===b[d])return b[a];
  return b.every(Boolean)?'draw':'';
}
function aiMove(board){
  const free=board.map((x,i)=>x?null:i).filter(x=>x!==null);
  if(!free.length)return;
  const winAt=(mark)=>{
    for(const i of free){const t=[...board];t[i]=mark;if(winner(t)===mark)return i}
    return null;
  };
  let move=winAt('O');
  if(move===null)move=winAt('X');
  if(move===null&&free.includes(4))move=4;
  if(move===null){
    const corners=free.filter(i=>[0,2,6,8].includes(i));
    move=random(corners.length?corners:free);
  }
  board[move]='O';
}

export const GAME_ENGINE_COMMANDS=new Set(['riddle','quiz','tictactoe']);
export function canHandleGameCommand(name){return GAME_ENGINE_COMMANDS.has(String(name||'').toLowerCase())}

export async function handleGameCommand({runtime,event,name,args=[]}){
  const {client,account}=runtime,peer=event.message.peerId;
  const k=key(account,event),input=args.join(' ').trim();
  const say=t=>client.sendMessage(peer,{message:String(t)});

  if(name==='riddle'){
    const state=getState(k);
    if(input&&state?.kind==='riddle'){
      const ok=state.answers.some(a=>norm(a)===norm(input));
      clearState(k);
      await say((ok?'Correct.':'Raté.')+' Réponse : '+state.answer+'.');
      return true;
    }
    const r=random(RIDDLES);
    setState(k,{kind:'riddle',answers:r.a,answer:r.a[0]});
    await say('Devinette\n\n'+r.q+'\n\nRéponds avec .riddle <réponse>.');
    return true;
  }

  if(name==='quiz'){
    const state=getState(k);
    if(input&&state?.kind==='quiz'){
      let choice=-1;
      if(/^\d+$/.test(input))choice=Number(input)-1;
      else choice=state.choices.findIndex(x=>norm(x)===norm(input));
      const ok=choice===state.answer;
      const correct=state.choices[state.answer];
      clearState(k);
      await say((ok?'Correct.':'Raté.')+' Bonne réponse : '+correct+'.');
      return true;
    }
    const q=random(QUIZZES);
    setState(k,{kind:'quiz',answer:q.a,choices:q.choices});
    await say('Quiz\n\n'+q.q+'\n\n'+q.choices.map((x,i)=>(i+1)+'. '+x).join('\n')+'\n\nRéponds avec .quiz <numéro>.');
    return true;
  }

  if(name==='tictactoe'){
    let state=getState(k);
    const sub=norm(input);
    if(sub==='stop'||sub==='cancel'||sub==='reset'){
      clearState(k);await say('Morpion arrêté.');return true;
    }
    if(!state||state.kind!=='ttt'||!input){
      state={kind:'ttt',board:Array(9).fill('')};
      setState(k,state);
      await say('Morpion · toi = X, NexAi = O\n\n'+boardText(state.board)+'\n\nJoue avec .tictactoe <1-9>.');
      return true;
    }
    const pos=Number(args[0])-1;
    if(!Number.isInteger(pos)||pos<0||pos>8){await say('Choisis une case de 1 à 9.');return true}
    if(state.board[pos]){await say('Cette case est déjà prise.\n\n'+boardText(state.board));return true}
    state.board[pos]='X';
    let w=winner(state.board);
    if(!w){aiMove(state.board);w=winner(state.board)}
    if(w){
      clearState(k);
      await say(boardText(state.board)+'\n\n'+(w==='X'?'Tu as gagné.':w==='O'?'NexAi a gagné.':'Match nul.'));
      return true;
    }
    setState(k,state);
    await say(boardText(state.board)+'\n\nÀ toi : .tictactoe <1-9>.');
    return true;
  }
  return false;
}
