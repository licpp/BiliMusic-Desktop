export const MAX_BYTES = 3 * 1024 * 1024;
export class ApiError extends Error { constructor(status,message) { super(message); this.status=status; } }
const fields = {
  collectionFolder:["id","name"], collection:["bvid","folderId"], collectionProgress:["reference","checkpoint"],
  track:['id','bvid','cid','overrideTitle','overrideArtist','overrideAlbum','overrideCover'],
  playlist:['id','name','description','coverUrl'], item:['playlistId','trackId','position'],
  favorite:['trackId'], history:['trackId','playedAt','resume'], lyric:['id','provider','providerLyricId','biasMs','manual'],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validCollectionReference(value) {
  if (typeof value !== 'string') return false;
  if (/^up:[1-9][0-9]{0,18}$/.test(value)) return BigInt(value.slice(3)) <= 9223372036854775807n;
  if (/^BV[a-zA-Z0-9]+$/.test(value)) return value.length <= 32;
  const match = /^season:([1-9][0-9]{0,18}):([1-9][0-9]{0,18})$/.exec(value);
  return !!match && BigInt(match[1]) <= 9223372036854775807n && BigInt(match[2]) <= 9223372036854775807n;
}
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
    else if(r.kind==='collection'){if(!validCollectionReference(f.bvid)||key!==`collection:${f.bvid}`||typeof f.folderId!=='string'||(f.folderId!==''&&value.records[`collectionFolder:${f.folderId}`]?.kind!=='collectionFolder'))fail();}
    else if(r.kind==='collectionProgress'){
      const match=typeof f.checkpoint==='string' && /^([1-9]\d*):(BV[a-zA-Z0-9]+):([1-9]\d*):(\d+)$/.exec(f.checkpoint);
      if(!validCollectionReference(f.reference)||key!==`collectionProgress:${f.reference}`||value.records[`collection:${f.reference}`]?.kind!=='collection'||!match||!Number.isSafeInteger(+match[1])||!validCollectionReference(match[2])||BigInt(match[3])>9223372036854775807n||+match[4]>604800000||(!f.reference.startsWith('season:')&&f.reference!==match[2]))fail();
    }
    else if(r.kind==='playlist') {if(!uuid.test(f.id)||typeof f.name!=='string'||!f.name.trim()||key!==`playlist:${f.id}`) fail();}
    else if(r.kind==='lyric') {if(key!==`lyric:${f.id}`||!['lrclib','netease','local'].includes(f.provider)||!Number.isSafeInteger(f.biasMs)||Math.abs(f.biasMs)>30000) fail();}
    else {
      if(typeof f.trackId!=='string') fail();referenced.add(f.trackId);
      if(r.kind==='item'){if(!uuid.test(f.playlistId)||key!==`item:${f.playlistId}|${f.trackId}`||!value.records[`playlist:${f.playlistId}`]||!Number.isSafeInteger(f.position)||f.position<0)fail();}
      else if(key!==`${r.kind}:${f.trackId}`) fail();
      if(r.kind==='history'&&Object.hasOwn(f,'resume')){
        const resume=typeof f.resume==='string'&&/^([1-9]\d*):(\d+)$/.exec(f.resume);
        if(!resume||!Number.isSafeInteger(+resume[1])||+resume[2]>604800000)fail();
      }
      if(r.kind==='history'&&(typeof f.playedAt!=='string'||!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{3})?$/.test(f.playedAt)))fail();
    }
  }
  for(const id of referenced)if(!tracks.has(id))fail();
  for(const id of tracks)if(!referenced.has(id))fail();
  for(const r of Object.values(value.records))if(r.kind==='lyric'&&!tracks.has(r.fields.id))fail();
  for(const [kind,max] of Object.entries({collectionFolder:100,collection:2000,collectionProgress:2000,playlist:500,track:5000,item:10000,history:200,lyric:5000,favorite:5000}))if((counts[kind]||0)>max)throw new ApiError(413,`${kind}超过数量上限${max}`);
  return value;
}
