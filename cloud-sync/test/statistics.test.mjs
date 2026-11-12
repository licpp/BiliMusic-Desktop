import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHandler } from '../app.mjs';
class Store {
 sessions=new Map(); files=new Map();
 async session(h,u){this.sessions.set(h,u)} async authenticate(h){return this.sessions.get(h)}
 async statisticsRead(uid,name){return this.files.get(`${uid}/${name}`)}
 async statisticsSources(uid){return [...this.files].filter(([k])=>k.startsWith(`${uid}/index-`)).map(([,v])=>v.source)}
 async statisticsWrite(uid,name,source,data,etag,revision,months){
  const old=await this.statisticsRead(uid,name);
  const fail=(status)=>{throw Object.assign(new Error('invalid'),{status})};
  if(!months&&old&&(old.revision>revision||old.revision===revision&&old.etag!==etag))fail(409);
  if(months)for(const[m,r]of Object.entries(months))if((await this.statisticsRead(uid,`${source}/${m}.json.gz`))?.revision<r||!await this.statisticsRead(uid,`${source}/${m}.json.gz`))fail(409);
  this.files.set(`${uid}/${name}`,{data,etag,revision,source});
 }
}
async function setup(t){const store=new Store();const server=http.createServer(createHandler(store,{verify:async c=>c==='SESSDATA=a'?'42':'43'}));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const root=`http://127.0.0.1:${server.address().port}/api/sync/v1`;async function auth(cookie){return(await(await fetch(`${root}/auth`,{method:'POST',body:JSON.stringify({cookie})})).json()).token}const token=await auth('SESSDATA=a'),other=await auth('SESSDATA=b');return {root,token,other};}
function sample(source){return {schema:1,uid:'42',source,month:'2026-11',revision:1,tracks:{'bilibili:BV1:1':60},days:{'2026-11-12':60},daily:{'2026-11-12':{'bilibili:BV1:1':60}},names:{'bilibili:BV1:1':['Song','Artist']}}}
test('compressed month and index roundtrip, ETag caching, account isolation and duplicate retry',async t=>{
 const{root,token,other}=await setup(t);const source=randomUUID(),b=sample(source),url=`${root}/statistics/${source}/2026-11.json.gz`,headers={Authorization:`Bearer ${token}`},body=gzipSync(JSON.stringify(b));
 assert.equal((await fetch(url,{method:'PUT',headers,body})).status,200);
 assert.equal((await fetch(url,{method:'PUT',headers,body})).status,200);
 const index=`${root}/statistics/index-${source}.json`;
 assert.equal((await fetch(index,{method:'PUT',headers,body:JSON.stringify({months:{'2026-11':1}})})).status,200);
 assert.deepEqual(await(await fetch(`${root}/statistics/`,{headers})).json(),[source]);
 const read=await fetch(url,{headers});assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await read.arrayBuffer()))),b);
 const ir=await fetch(index,{headers});assert.equal((await fetch(index,{headers:{...headers,'If-None-Match':ir.headers.get('etag')}})).status,304);
 assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${other}`}})).status,404);
 assert.equal((await fetch(url)).status,401);
});
test('reject wrong identities, malformed payloads, revisions and index before month commit',async t=>{
 const{root,token}=await setup(t);const source=randomUUID(),b=sample(source),url=`${root}/statistics/${source}/2026-11.json.gz`,headers={Authorization:`Bearer ${token}`};
 const put=async b=>fetch(url,{method:'PUT',headers,body:gzipSync(JSON.stringify(b))});
 assert.equal((await put({...b,uid:'43'})).status,400);
 assert.equal((await put({...b,source:randomUUID()})).status,400);
 assert.equal((await put({...b,tracks:{x:-1}})).status,400);
 assert.equal((await put({...b,cookie:'secret'})).status,400);
 assert.equal((await fetch(`${root}/statistics/index-${source}.json`,{method:'PUT',headers,body:JSON.stringify({months:{'2026-11':1}})})).status,409);
 assert.equal((await put(b)).status,200);
 assert.equal((await put({...b,revision:0})).status,409);
 assert.equal((await put({...b,tracks:{x:50}})).status,409);
 assert.equal((await fetch(url,{method:'PUT',headers,body:'broken gzip'})).status,400);
});
