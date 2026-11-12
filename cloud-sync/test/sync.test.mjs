import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../app.mjs';
import { validateSnapshot } from '../protocol.mjs';
class Store {
 sessions=new Map(); vaults=new Map();
 async health(){} async session(hash,uid){this.sessions.set(hash,uid);} async authenticate(hash){return this.sessions.get(hash);}
 async read(uid){return this.vaults.get(uid);} async write(uid,version,create,snapshot){const old=this.vaults.get(uid);if(create?!!old:old?.revision!==version)return null;const revision=randomUUID();this.vaults.set(uid,{snapshot,revision});return revision;}
 async revoke(hash){this.sessions.delete(hash);}async remove(uid){this.vaults.delete(uid);for(const[h,u]of this.sessions)if(u===uid)this.sessions.delete(h);}
}
const sample=uid=>({schema:1,uid,records:{'track:bilibili:BV1:1':{kind:'track',fields:{id:'bilibili:BV1:1',bvid:'BV1',cid:1,overrideTitle:'My edit'}},'favorite:bilibili:BV1:1':{kind:'favorite',fields:{trackId:'bilibili:BV1:1'}}}});
test('imported playlists and memberships accept import UUIDs and reject malformed identities',()=>{
  for (const [id,valid] of [['8076ad4b-2861-4be1-8b08-a6a0fb0b0579',true],['import:8076ad4b-2861-4be1-8b08-a6a0fb0b0579',true],['import:',false],['import:bad',false],['import:import:8076ad4b-2861-4be1-8b08-a6a0fb0b0579',false],['system:favorites',false]]) {
    const snapshot=sample('42');
    snapshot.records[`playlist:${id}`]={kind:'playlist',fields:{id,name:'Imported'}};
    snapshot.records[`item:${id}|bilibili:BV1:1`]={kind:'item',fields:{playlistId:id,trackId:'bilibili:BV1:1',position:0}};
    if (valid) assert.equal(validateSnapshot(snapshot,'42'),snapshot);
    else assert.throws(()=>validateSnapshot(snapshot,'42'));
  }
});
test('QQ lyric selections sync as an ID and bias, without lyric bodies',()=>{
  const snapshot=sample('42');
  snapshot.records['lyric:bilibili:BV1:1']={kind:'lyric',fields:{id:'bilibili:BV1:1',provider:'qq',providerLyricId:'213086592',biasMs:500,manual:true}};
  assert.equal(validateSnapshot(snapshot,'42'),snapshot);
  snapshot.records['lyric:bilibili:BV1:1'].fields.translatedLyrics='never upload lyric bodies';
  assert.throws(()=>validateSnapshot(snapshot,'42'));
});
async function setup(t){const store=new Store();const server=http.createServer(createHandler(store,{verify:async cookie=>{if(cookie==='SESSDATA=one')return '42';if(cookie==='SESSDATA=two')return '43';throw Error('invalid');}}));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const url=`http://127.0.0.1:${server.address().port}/api/sync/v1`;const auth=async cookie=>{const r=await fetch(url+'/auth',{method:'POST',body:JSON.stringify({cookie,uid:'999'})});assert.equal(r.status,200);return(await r.json()).token;};return{store,url,auth};}
test('server derives identity from verification, isolates users and never stores cookies',async t=>{const{store,url,auth}=await setup(t);const a=await auth('SESSDATA=one'),b=await auth('SESSDATA=two');assert.equal(JSON.stringify([...store.sessions]).includes('SESSDATA'),false);let r=await fetch(url+'/vault',{method:'PUT',headers:{Authorization:`Bearer ${a}`,'If-None-Match':'*'},body:JSON.stringify(sample('42'))});assert.equal(r.status,200);r=await fetch(url+'/vault?uid=42',{headers:{Authorization:`Bearer ${b}`}});assert.equal(r.status,404);r=await fetch(url+'/vault',{method:'PUT',headers:{Authorization:`Bearer ${b}`,'If-None-Match':'*'},body:JSON.stringify(sample('42'))});assert.equal(r.status,400);assert.equal((await fetch(url+'/vault')).status,401);});
test('conditional writes prevent lost updates and deletion revokes all devices',async t=>{const{url,auth}=await setup(t);const a=await auth('SESSDATA=one'),b=await auth('SESSDATA=one');const headers={Authorization:`Bearer ${a}`,'If-None-Match':'*'};const write=()=>fetch(url+'/vault',{method:'PUT',headers,body:JSON.stringify(sample('42'))});assert.equal((await write()).status,200);assert.equal((await write()).status,412);const read=await fetch(url+'/vault',{headers:{Authorization:`Bearer ${a}`}});const tag=read.headers.get('etag');assert.ok(tag);const updated=sample('42');updated.records['track:bilibili:BV1:1'].fields.overrideArtist='Singer';assert.equal((await fetch(url+'/vault',{method:'PUT',headers:{Authorization:`Bearer ${b}`,'If-Match':tag},body:JSON.stringify(updated)})).status,200);assert.equal((await fetch(url+'/vault',{method:'PUT',headers:{Authorization:`Bearer ${a}`,'If-Match':tag},body:JSON.stringify(sample('42'))})).status,412);assert.equal((await fetch(url+'/vault',{method:'DELETE',headers:{Authorization:`Bearer ${a}`}})).status,200);assert.equal((await fetch(url+'/vault',{headers:{Authorization:`Bearer ${b}`}})).status,401);});
test('protocol rejects source caches, unreferenced edits and excessive history',()=>{const s=sample('42');assert.equal(validateSnapshot(s,'42'),s);const raw=structuredClone(s);raw.records['track:bilibili:BV1:1'].fields.uploaderName='should stay local';assert.throws(()=>validateSnapshot(raw,'42'));delete s.records['favorite:bilibili:BV1:1'];assert.throws(()=>validateSnapshot(s,'42'));const h=sample('42');for(let i=0;i<201;i++){h.records[`track:bilibili:BV1:${i+1}`]={kind:'track',fields:{id:`bilibili:BV1:${i+1}`,bvid:'BV1',cid:i+1}};h.records[`history:bilibili:BV1:${i+1}`]={kind:'history',fields:{trackId:`bilibili:BV1:${i+1}`,playedAt:'2026-10-28 01:00:00'}};}assert.throws(()=>validateSnapshot(h,'42'),/200/);});

test('collection references sync without part lists or source caches',()=>{
 const id='f8b332ef-952e-41a6-8b36-7bb3ae620a78';
 const s={schema:1,uid:'42',records:{[`collectionFolder:${id}`]:{kind:'collectionFolder',fields:{id,name:'听书'}},'collection:BV123':{kind:'collection',fields:{bvid:'BV123',folderId:id}}}};
 assert.equal(validateSnapshot(s,'42'),s);
 const cached=structuredClone(s);cached.records['collection:BV123'].fields.title='不应上传';assert.throws(()=>validateSnapshot(cached,'42'));
 delete s.records[`collectionFolder:${id}`];assert.throws(()=>validateSnapshot(s,'42'));
 s.records['collection:BV123'].fields.folderId='';assert.equal(validateSnapshot(s,'42'),s);
});

test('collection checkpoints require a saved collection and contain no source metadata', () => {
  const record = {kind:'collectionProgress', fields:{reference:'season:42:73', checkpoint:'1794355030000:BV123:7:85000'}};
  const snapshot = {schema:1, uid:'42', records:{
    'collection:season:42:73': {kind:'collection', fields:{bvid:'season:42:73', folderId:''}},
    'collectionProgress:season:42:73': record,
  }};
  assert.equal(validateSnapshot(snapshot, '42'), snapshot);
  record.fields.checkpoint = '1794355030000:BV123:7:-1';
  assert.throws(() => validateSnapshot(snapshot, '42'));
  record.fields.checkpoint = '1794355030000:BV123:7:85000';
  delete snapshot.records['collection:season:42:73'];
  assert.throws(() => validateSnapshot(snapshot, '42'));
});

test('old cloud clients can read and update a vault while preserving extended data', async t => {
  const {url,auth} = await setup(t);
  const headers = {Authorization:`Bearer ${await auth('SESSDATA=one')}`};
  const format = {'x-bilimusic-sync-format':'track-checkpoints'};
  const key = 'collectionProgress:BV123';
  const historyKey = 'history:bilibili:BV1:1';
  const snapshot = sample('42');
  snapshot.records['collection:BV123'] = {kind:'collection',fields:{bvid:'BV123',folderId:''}};
  snapshot.records[key] = {kind:'collectionProgress',fields:{reference:'BV123',checkpoint:'1794355030000:BV123:7:85000'}};
  snapshot.records[historyKey] = {kind:'history',fields:{trackId:'bilibili:BV1:1',playedAt:'2026-11-10 00:00:00.123',resume:'1794355030000:0'}};
  const write = await fetch(url+'/vault',{method:'PUT',headers:{...headers,...format,'If-None-Match':'*'},body:JSON.stringify(snapshot)});
  assert.equal(write.status,200);
  const previousClient = await fetch(url+'/vault',{headers:{...headers,'x-bilimusic-sync-format':'checkpoints'}});
  const previousSnapshot = await previousClient.json();
  assert.deepEqual(previousSnapshot.records[key],snapshot.records[key]);
  assert.equal(previousSnapshot.records[historyKey].fields.resume,undefined);
  const oldUpdate = await fetch(url+'/vault',{method:'PUT',headers:{...headers,'x-bilimusic-sync-format':'checkpoints','If-Match':previousClient.headers.get('etag')},body:JSON.stringify(previousSnapshot)});
  assert.equal(oldUpdate.status,200);
  const legacyRead = await fetch(url+'/vault',{headers});
  const legacy = await legacyRead.json();
  assert.equal(legacy.records[key],undefined);
  assert.equal(legacy.records[historyKey].fields.resume,undefined);
  assert.equal(legacy.records[historyKey].fields.playedAt,'2026-11-10 00:00:00');
  legacy.records['track:bilibili:BV1:1'].fields.overrideArtist='Singer';
  const update = await fetch(url+'/vault',{method:'PUT',headers:{...headers,'If-Match':legacyRead.headers.get('etag')},body:JSON.stringify(legacy)});
  assert.equal(update.status,200);
  const read = await fetch(url+'/vault',{headers:{...headers,...format}});
  assert.equal(read.headers.get('x-bilimusic-sync-format'),'track-checkpoints');
  const restored = await read.json();
  assert.deepEqual(restored.records[key],snapshot.records[key]);
  assert.deepEqual(restored.records[historyKey],snapshot.records[historyKey]);
  assert.equal(restored.records['track:bilibili:BV1:1'].fields.overrideArtist,'Singer');
});

test('creator subscriptions are projected out for old clients and survive their writes', async t => {
  const {url,auth}=await setup(t);
  const token=await auth('SESSDATA=one');
  const headers={Authorization:`Bearer ${token}`,'x-bilimusic-sync-format':'creator-progress'};
  const snapshot=sample('42');
  snapshot.records['collection:up:42']={kind:'collection',fields:{bvid:'up:42',folderId:''}};
  snapshot.records['collectionProgress:up:42']={kind:'collectionProgress',fields:{reference:'up:42',checkpoint:'1794364100000:BV123:7:85000'}};
  const put=await fetch(url+'/vault',{method:'PUT',headers:{...headers,'If-None-Match':'*'},body:JSON.stringify(snapshot)});
  assert.equal(put.status,200);
  const olderHeaders={...headers,'x-bilimusic-sync-format':'track-checkpoints'};
  const creatorView=await fetch(url+'/vault',{headers:{...headers,'x-bilimusic-sync-format':'creators'}});
  const creatorSnapshot=await creatorView.json();
  assert.ok(creatorSnapshot.records['collection:up:42']);
  assert.equal(creatorSnapshot.records['collectionProgress:up:42'],undefined);
  const old=await fetch(url+'/vault',{headers:olderHeaders});
  const oldSnapshot=await old.json();
  assert.equal(oldSnapshot.records['collection:up:42'],undefined);
  assert.equal(oldSnapshot.records['collectionProgress:up:42'],undefined);
  const written=await fetch(url+'/vault',{method:'PUT',headers:{...olderHeaders,'If-Match':old.headers.get('etag')},body:JSON.stringify(oldSnapshot)});
  assert.equal(written.status,200);
  const restored=await fetch(url+'/vault',{headers});
  const records=(await restored.json()).records;
  assert.deepEqual(records['collection:up:42'],snapshot.records['collection:up:42']);
  assert.deepEqual(records['collectionProgress:up:42'],snapshot.records['collectionProgress:up:42']);
});

test('creator folder scopes roundtrip and survive legacy creator-progress edits',async t=>{
 const {url,auth}=await setup(t);const token=await auth('SESSDATA=one');const id=randomUUID();const s=sample('42');s.records[`collectionFolder:${id}`]={kind:'collectionFolder',fields:{id,name:'UP分组',scope:'creators'}};
 const headers={Authorization:`Bearer ${token}`,'x-bilimusic-sync-format':'creator-groups'};
 assert.equal((await fetch(url+'/vault',{method:'PUT',headers:{...headers,'If-None-Match':'*'},body:JSON.stringify(s)})).status,200);
 const modern=await fetch(url+'/vault',{headers});assert.equal(modern.headers.get('x-bilimusic-sync-format'),'creator-groups');assert.equal((await modern.json()).records[`collectionFolder:${id}`].fields.scope,'creators');
 const oldHeaders={...headers,'x-bilimusic-sync-format':'creator-progress'};const old=await fetch(url+'/vault',{headers:oldHeaders});const oldData=await old.json();assert.equal(oldData.records[`collectionFolder:${id}`].fields.scope,undefined);oldData.records[`collectionFolder:${id}`].fields.name='重命名';
 assert.equal((await fetch(url+'/vault',{method:'PUT',headers:{...oldHeaders,'If-Match':old.headers.get('etag')},body:JSON.stringify(oldData)})).status,200);
 const next=await(await fetch(url+'/vault',{headers})).json();assert.equal(next.records[`collectionFolder:${id}`].fields.scope,'creators');assert.equal(next.records[`collectionFolder:${id}`].fields.name,'重命名');
});
