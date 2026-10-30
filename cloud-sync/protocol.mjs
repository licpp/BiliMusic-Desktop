export const MAX_BYTES = 3 * 1024 * 1024;
export class ApiError extends Error { constructor(status,message) { super(message); this.status=status; } }
const fields = {
  collectionFolder:["id","name"], collection:["bvid","folderId"],
  track:['id','bvid','cid','overrideTitle','overrideArtist','overrideAlbum','overrideCover'],
  playlist:['id','name','description','coverUrl'], item:['playlistId','trackId','position'],
  favorite:['trackId'], history:['trackId','playedAt'], lyric:['id','provider','providerLyricId','biasMs','manual'],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateSnapshot(value, uid) {
  const fail=()=>{throw new ApiError(400,'同步记录格式无效或包含不允许上传的字段');};
  if (!value || value.schema!==1 || value.uid!==uid || !/^\d+$/.test(uid) || !value.records || Array.isArray(value.records) || Object.keys(value).sort().join(',')!=='records,schema,uid') fail();
  if (Buffer.byteLength(JSON.stringify(value))>MAX_BYTES) throw new ApiError(413,'同步数据超过3MB上限');
  const counts={}, referenced=new Set(), tracks=new Set();
  if(Object.keys(value.records).length>22000) fail();
  for (const [key,r] of Object.entries(value.records)) {
    if(!r||Object.keys(r).sort().join(',')!=='fields,kind'||!Object.hasOwn(fields,r.kind)||!r.fields||Array.isArray(r.fields)||key.length>240) fail();
    counts[r.kind]=(counts[r.kind]||0)+1;
    for(const [field,v] of Object.entries(r.fields)) {
      if(!fields[r.kind].includes(field)||!(v===null||typeof v==='string'||typeof v==='boolean'||Number.isSafeInteger(v))||(typeof v==='string'&&Buffer.byteLength(v)>4096)) fail();
      if(['coverUrl','overrideCover'].includes(field)&&v) {try {const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password||['localhost','127.0.0.1','[::1]'].includes(u.hostname)) fail();}catch{fail();}}
    }
    const f=r.fields;
    if (r.kind==='track') {if(!/^BV[a-zA-Z0-9]+$/.test(f.bvid)||!Number.isSafeInteger(f.cid)||f.cid<=0||f.id!==`bilibili:${f.bvid}:${f.cid}`||key!==`track:${f.id}`) fail();tracks.add(f.id);}
    else if(r.kind==='collectionFolder'){if(!uuid.test(f.id)||typeof f.name!=='string'||!f.name.trim()||[...f.name].length>80||key!==`collectionFolder:${f.id}`)fail();}
    else if(r.kind==='collection'){if(typeof f.bvid!=='string'||!/^BV[a-zA-Z0-9]+$/.test(f.bvid)||f.bvid.length>32||key!==`collection:${f.bvid}`||typeof f.folderId!=='string'||(f.folderId!==''&&value.records[`collectionFolder:${f.folderId}`]?.kind!=='collectionFolder'))fail();}
    else if(r.kind==='playlist') {if(!uuid.test(f.id)||typeof f.name!=='string'||!f.name.trim()||key!==`playlist:${f.id}`) fail();}
    else if(r.kind==='lyric') {if(key!==`lyric:${f.id}`||!['lrclib','netease','local'].includes(f.provider)||!Number.isSafeInteger(f.biasMs)||Math.abs(f.biasMs)>30000) fail();}
    else {
      if(typeof f.trackId!=='string') fail();referenced.add(f.trackId);
      if(r.kind==='item'){if(!uuid.test(f.playlistId)||key!==`item:${f.playlistId}|${f.trackId}`||!value.records[`playlist:${f.playlistId}`]||!Number.isSafeInteger(f.position)||f.position<0)fail();}
      else if(key!==`${r.kind}:${f.trackId}`) fail();
      if(r.kind==='history'&&(typeof f.playedAt!=='string'||!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(f.playedAt)))fail();
    }
  }
  for(const id of referenced)if(!tracks.has(id))fail();
  for(const id of tracks)if(!referenced.has(id))fail();
  for(const r of Object.values(value.records))if(r.kind==='lyric'&&!tracks.has(r.fields.id))fail();
  for(const [kind,max] of Object.entries({collectionFolder:100,collection:2000,playlist:500,track:5000,item:10000,history:200,lyric:5000,favorite:5000}))if((counts[kind]||0)>max)throw new ApiError(413,`${kind}超过数量上限${max}`);
  return value;
}
