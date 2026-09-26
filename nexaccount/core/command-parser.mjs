export function textOf(message){
  return String(message?.message||message?.text||'').trim();
}

export function parseCommand(text,prefix='.'){
  const value=String(text||'').trim();
  if(!value)return null;

  if(value.startsWith('/')){
    const [head,...args]=value.slice(1).split(/\s+/);
    const name=String(head||'').replace(/@[^\s]+$/,'').toLowerCase();
    return name?{name,args}:null;
  }

  if(prefix&&value.startsWith(prefix)){
    const [head,...args]=value.slice(String(prefix).length).split(/\s+/);
    const name=String(head||'').toLowerCase();
    return name?{name,args}:null;
  }

  return null;
}
