export default async function handler(req,res){
  const raw=String(req.query?.u||'').replace(/^@/,'').trim();
  if(!/^[A-Za-z0-9_]{5,64}$/.test(raw)){
    res.status(400).end('invalid_username');
    return;
  }

  const headers={
    'user-agent':'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36',
    'accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  };

  async function fetchImage(url){
    const r=await fetch(url,{headers,redirect:'follow'});
    const type=String(r.headers.get('content-type')||'');
    if(!r.ok||!type.startsWith('image/')) return null;
    const body=Buffer.from(await r.arrayBuffer());
    if(!body.length) return null;
    return {body,type};
  }

  try{
    let img=await fetchImage('https://t.me/i/userpic/320/'+encodeURIComponent(raw)+'.jpg');

    if(!img){
      const page=await fetch('https://t.me/'+encodeURIComponent(raw),{
        headers:{...headers,accept:'text/html,application/xhtml+xml'},
        redirect:'follow'
      });
      if(page.ok){
        const html=await page.text();
        const match=html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        if(match?.[1]){
          const imageUrl=match[1].replace(/&amp;/g,'&');
          img=await fetchImage(imageUrl);
        }
      }
    }

    if(!img){
      res.setHeader('Cache-Control','public, s-maxage=300, stale-while-revalidate=3600');
      res.status(404).end('avatar_not_found');
      return;
    }

    res.setHeader('Content-Type',img.type);
    res.setHeader('Cache-Control','public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.status(200).send(img.body);
  }catch(err){
    res.setHeader('Cache-Control','public, s-maxage=60');
    res.status(502).end('avatar_upstream_error');
  }
}
