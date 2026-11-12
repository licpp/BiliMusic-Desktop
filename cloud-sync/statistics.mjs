import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ApiError } from './protocol.mjs';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const indexPattern=new RegExp(`^index-(${uuid})\\.json$`);
const monthPattern=new RegExp(`^(${uuid})/(baseline|[0-9]{4}-(?:0[1-9]|1[0-2]))\\.json\\.gz$`);
function object(v){return v&&typeof v==='object'&&!Array.isArray(v);}
function counters(v,max,key){return object(v)&&Object.keys(v).length<=max&&Object.entries(v).every(([k,n])=>key(k)&&Number.isFinite(n)&&n>=0);}
export async function statisticsRequest(req,res,store,uid,path,tokenHash){
 if(!path.startsWith('/statistics/'))return false;
 const name=path.slice('/statistics/'.length);
 if(!name&&req.method==='GET'){const sources=await store.statisticsSources(uid);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(sources));return true;}
 const index=name.match(indexPattern),month=name.match(monthPattern);
 if(!index&&!month)throw new ApiError(400,'统计路径无效');
 if(req.method==='GET'){
  const v=await store.statisticsRead(uid,name);if(!v)throw new ApiError(404,'统计文件不存在');
  const headers={ETag:`"${v.etag}"`,'Cache-Control':'private, no-cache','Content-Type':index?'application/json':'application/gzip'};
  if(req.headers['if-none-match']===headers.ETag){res.writeHead(304,headers);res.end();}else{res.writeHead(200,headers);res.end(v.data);}return true;
 }
 if(req.method!=='PUT')throw new ApiError(405,'不支持的统计操作');
 let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw new ApiError(413,'统计文件过大');chunks.push(chunk);}
 const data=Buffer.concat(chunks);let v;
 try{v=JSON.parse(index?data.toString():gunzipSync(data,{maxOutputLength:8*1024*1024}).toString());}catch{throw new ApiError(400,'统计文件编码无效');}
 let revision=0;
 if(index){
  if(!object(v)||Object.keys(v).join()!=='months'||!object(v.months)||Object.keys(v.months).length>1200||!Object.entries(v.months).every(([m,r])=>/^(baseline|[0-9]{4}-(0[1-9]|1[0-2]))$/.test(m)&&Number.isSafeInteger(r)&&r>=0))throw new ApiError(400,'统计索引无效');
 }else{
  const key=k=>typeof k==='string'&&k.length<=240;
  if(!object(v)||Object.keys(v).some(k=>!['schema','uid','source','month','revision','tracks','days','daily','names','plays','day_plays','daily_plays'].includes(k))||v.schema!==1||v.uid!==uid||v.source!==month[1]||v.month!==month[2]||!Number.isSafeInteger(v.revision)||v.revision<0||!counters(v.tracks,50000,key)||!counters(v.days,36600,k=>/^\d{4}-\d{2}-\d{2}$/.test(k))||!object(v.daily)||Object.keys(v.daily).length>36600||!Object.entries(v.daily).every(([d,ts])=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&counters(ts,50000,key))||!object(v.names)||Object.keys(v.names).length>50000||!Object.entries(v.names).every(([k,n])=>key(k)&&Array.isArray(n)&&n.length===2&&n.every(t=>typeof t==='string'&&Buffer.byteLength(t)<=4096)))throw new ApiError(400,'统计内容无效');
  for(const field of ['plays','day_plays'])if(v[field]!==undefined&&!counters(v[field],50000,key))throw new ApiError(400,'统计次数无效');
  if(v.daily_plays!==undefined&&(!object(v.daily_plays)||Object.keys(v.daily_plays).length>36600||!Object.values(v.daily_plays).every(ts=>counters(ts,50000,key))))throw new ApiError(400,'逐日次数无效');
  revision=v.revision;
 }
 const etag=createHash('sha256').update(data).digest('hex');
 await store.statisticsWrite(uid,name,index?.[1]||month[1],data,etag,revision,index?v.months:null,tokenHash);
 res.writeHead(200,{ETag:`"${etag}"`,'Content-Type':'application/json'});res.end('{"ok":true}');return true;
}
