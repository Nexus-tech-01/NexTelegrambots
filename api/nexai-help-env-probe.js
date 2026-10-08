export default function handler(req,res){
  const keys=[
    'NEXUS_MONGODB_URI',
    'NEXANIME__API_ID',
    'NEXANIME__API_HASH',
    'NEXANIME__SESSION_TRESOR20001'
  ];
  const present={};
  for(const k of keys)present[k]=Boolean(String(process.env[k]||'').trim());
  res.setHeader('cache-control','no-store');
  res.status(200).json({ok:true,present});
}
