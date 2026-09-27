export function textOf(message){
  return String(message?.message||message?.text||'').trim();
}

function splitCommand(value,start,kind){
  const [head,...args]=String(value||'').slice(start).split(/\s+/);
  const name=String(head||'').replace(kind==='slash'?/@[^\s]+$/:/$^/,'').toLowerCase();
  return name?{name,args,kind}:null;
}

export function parseCommand(text,prefix='.',options={}){
  const value=String(text||'').trim();
  if(!value)return null;

  if(value.startsWith('/'))return splitCommand(value,1,'slash');

  if(prefix&&value.startsWith(prefix)){
    return splitCommand(value,String(prefix).length,'prefix');
  }

  if(options?.allowBare===true&&typeof options?.isKnownCommand==='function'){
    const [head,...args]=value.split(/\s+/);
    const name=String(head||'').toLowerCase();
    if(name&&options.isKnownCommand(name)===true)return {name,args,kind:'bare'};
  }

  return null;
}
