import { randomBytes, createHash } from 'node:crypto';
import { ApiError, MAX_BYTES, validateSnapshot } from './protocol.mjs';
import { syncPolicy } from './privacy.mjs';
const formatHeader = 'x-bilimusic-sync-format';
const checkpoints = 'checkpoints';
const trackCheckpoints = 'track-checkpoints';
const creators = 'creators';
function projectedView(snapshot, format) {
  if (format === creators) return snapshot;
  return {...snapshot,records:Object.fromEntries(Object.entries(snapshot.records)
    .filter(([, record])=>!(record.kind==='collection' && record.fields.bvid.startsWith('up:')))
    .filter(([, record])=>[checkpoints,trackCheckpoints,creators].includes(format)||record.kind!=='collectionProgress')
    .map(([key, record])=>{
      if(format===trackCheckpoints||record.kind!=='history')return [key,record];
      const {resume, ...fields}=record.fields;
      if(format!==checkpoints)fields.playedAt=fields.playedAt.slice(0,19);
      return [key,{...record,fields}];
    }))};
}
function preserveExtendedRecords(snapshot, previous, format) {
  for (const [key, record] of Object.entries(previous.records)) {
    if (record.kind==='collection' && record.fields.bvid.startsWith('up:')) { snapshot.records[key]=record; } else if (format!==trackCheckpoints && format!==checkpoints && record.kind==='collectionProgress' && snapshot.records[`collection:${record.fields.reference}`]) {
      snapshot.records[key]=record;
    } else if (format!==trackCheckpoints && record.kind==='history' && snapshot.records[key]?.kind==='history') {
      const fields=snapshot.records[key].fields;
      if(format!==checkpoints&&fields.playedAt===record.fields.playedAt.slice(0,19))fields.playedAt=record.fields.playedAt;
      if(record.fields.resume!==undefined)fields.resume=record.fields.resume;
    }
  }
}
const hash = s=>createHash('sha256').update(s).digest('hex');
export async function verifyBilibili(cookie) {
  const response=await fetch('https://api.bilibili.com/x/web-interface/nav',{headers:{Cookie:cookie,'User-Agent':'Mozilla/5.0','Referer':'https://www.bilibili.com/'},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new ApiError(503,'B站账号验证暂不可用，请稍后重试');
  const v=await response.json();
  if(v.code!==0||!v.data?.isLogin||!Number.isSafeInteger(v.data.mid)||v.data.mid<=0)throw new ApiError(401,'B站登录已失效，请重新登录');
  return String(v.data.mid);
}
async function readJson(req,max=MAX_BYTES) {let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw new ApiError(413,'请求超过大小限制');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'JSON无效');}}
export function createHandler(store,{verify=verifyBilibili,trustProxy=false}={}) {
  const limits=new Map();
  return async(req,res)=>{
    const json=(status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(value));};
    try {
      const path=new URL(req.url,'http://localhost').pathname.replace(/^\/api\/sync\/v1/,'');
      if(path==='/policy'&&req.method==='GET')return json(200,syncPolicy);
      if(path==='/health'&&req.method==='GET'){await store.health();return json(200,{status:'ok'});}
      const address=trustProxy?String(req.headers['x-forwarded-for']||'').split(',').at(-1)?.trim()||req.socket.remoteAddress:req.socket.remoteAddress;
      const bucket=`${address}:${path==='/auth'?'auth':'sync'}`;
      const now=Date.now();for(const [k,v]of limits)if(v.until<now)limits.delete(k);
      if(limits.size>10000)throw new ApiError(503,'服务繁忙');
      const limit=limits.get(bucket)||{count:0,until:now+(path==='/auth'?3600000:60000)};limits.set(bucket,limit);
      if(++limit.count>(path==='/auth'?10:120))return json(429,{message:'请求过于频繁'},{'Retry-After':'60'});
      if(path==='/auth'&&req.method==='POST') {
        const body=await readJson(req,12000);
        if(typeof body.cookie!=='string'||body.cookie.length>10000||!body.cookie.includes('SESSDATA=')||/[\r\n]/.test(body.cookie))throw new ApiError(400,'登录验证参数无效');
        const uid=await verify(body.cookie);body.cookie='';
        const token=randomBytes(32).toString('base64url');await store.session(hash(token),uid);
        return json(200,{uid,token,expiresIn:30*86400});
      }
      const token=req.headers.authorization?.match(/^Bearer ([\w-]{43})$/)?.[1];
      const uid=token?await store.authenticate(hash(token)):null;if(!uid)throw new ApiError(401,'同步授权已失效');
      if(path==='/vault'&&req.method==='GET') {
        const format=req.headers[formatHeader];
        const headers=[checkpoints,trackCheckpoints,creators].includes(format)?{[formatHeader]:format}:{};
        const v=await store.read(uid);if(!v?.snapshot)return json(404,{message:'尚无同步数据'},headers);
        return json(200,projectedView(v.snapshot,format),{...headers,ETag:`"${v.revision}"`});
      }
      if(path==='/vault'&&req.method==='PUT') {
        const snapshot=validateSnapshot(await readJson(req),uid);
        const match=req.headers['if-match'];const create=req.headers['if-none-match']==='*';
        if(!match&&!create)throw new ApiError(428,'必须提供版本条件');
        if(match&&!/^"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"$/i.test(match))throw new ApiError(400,'版本标识无效');
        const expected=match?.replace(/^"|"$/g,'');
        if (expected && !create && req.headers[formatHeader]!==creators) {
          const current=await store.read(uid);
          if(current?.revision!==expected)throw new ApiError(412,'云端已更新，请重新合并');
          if(current.snapshot)preserveExtendedRecords(snapshot,current.snapshot,req.headers[formatHeader]);
          validateSnapshot(snapshot,uid);
        }
        const revision=await store.write(uid,expected,create,snapshot,hash(token));
        if(!revision)throw new ApiError(412,'云端已更新，请重新合并');return json(200,{ok:true},{ETag:`"${revision}"`});
      }
      if(path==='/session'&&req.method==='DELETE'){await store.revoke(hash(token));return json(200,{ok:true});}
      if(path==='/vault'&&req.method==='DELETE'){await store.remove(uid);return json(200,{ok:true});}
      throw new ApiError(404,'接口不存在');
    } catch(e) {if(!res.headersSent)json(e.status||503,{message:e instanceof ApiError?e.message:'同步服务暂不可用'});else res.end();}
  };
}
