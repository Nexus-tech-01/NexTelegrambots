import crypto from 'node:crypto';

const rows=new Map();
const MAX_ROWS=500;
const TTL_MS=90_000;

function sweep(){
  const now=Date.now();
  for(const [key,row] of rows){
    if(row.expiresAt<=now)rows.delete(key);
  }
  if(rows.size<=MAX_ROWS)return;
  const ordered=[...rows.entries()].sort((a,b)=>a[1].createdAt-b[1].createdAt);
  for(const [key] of ordered.slice(0,rows.size-MAX_ROWS))rows.delete(key);
}

export function putInlineResponse(text,{ttlMs=TTL_MS}={}){
  sweep();
  const token=crypto.randomBytes(9).toString('base64url');
  rows.set(token,{
    text:String(text??'').slice(0,4096),
    createdAt:Date.now(),
    expiresAt:Date.now()+Math.max(10_000,Math.min(300_000,Number(ttlMs)||TTL_MS))
  });
  return token;
}

export function getInlineResponse(token){
  sweep();
  const row=rows.get(String(token||''));
  if(!row||row.expiresAt<=Date.now())return null;
  return row;
}

export function deleteInlineResponse(token){
  return rows.delete(String(token||''));
}
