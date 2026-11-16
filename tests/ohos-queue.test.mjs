import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const built=await build({entryPoints:['native/ohos-player/ohos/NativeQueue.ets'],bundle:true,loader:{'.ets':'ts'},resolveExtensions:['.ets','.ts'],write:false,format:'cjs'})
const m={exports:{}};new Function('module','exports',built.outputFiles[0].text)(m,m.exports)
const {NativeQueue}=m.exports
const track=(id,extra={})=>({id,title:id,durationSeconds:120,source:{provider:'bilibili',bvid:`BV${id}`,cid:1,page:1},...extra})
const a=track('a'),b=track('b'),c=track('c')
const mirror=(extra={})=>({tracks:[a,b,c],accountSession:'account-a',version:1,owner:'webview-a',repeatMode:'off',shuffled:false,...extra})
test('Harmony mirror is atomic, rejects stale owners and isolates expanded parts across accounts',()=>{
 const q=new NativeQueue();q.update(mirror({tracks:[track('entry',{resolveParts:true}),c]}))
 q.resolved({entryId:'entry',parts:[a,b]});assert.deepEqual(q.tracks.map(t=>t.id),['a','b','c'])
 assert.throws(()=>q.update(mirror({owner:'broken',tracks:[{}]})))
 assert.equal(q.owner,'webview-a');assert.equal(q.version,1)
 q.update(mirror({version:2,tracks:[track('entry',{resolveParts:true}),c]}));assert.deepEqual(q.tracks.map(t=>t.id),['a','b','c'])
 q.update(mirror({owner:'webview-b',accountSession:'account-b',tracks:[track('entry',{resolveParts:true}),c]}))
 assert.deepEqual(q.tracks.map(t=>t.id),['entry','c'])
 assert.equal(q.update(mirror({version:999})),false)
 assert.equal(q.update(mirror({owner:'webview-b',version:1})),false)
})
test('Harmony repeat, shuffle, manual wrap and part context match the shared queue policy',()=>{
 const q=new NativeQueue();q.update(mirror());assert.equal(q.target('c',1,true),undefined);assert.equal(q.target('c',1,false).id,'a');assert.equal(q.target('a',-1,false).id,'c')
 q.update(mirror({version:2,repeatMode:'one'}));assert.equal(q.target('b',1,true).id,'b');assert.equal(q.payload(b,true).restart,true)
 q.update(mirror({version:3,repeatMode:'all',shuffled:true}));for(const random of [0,.3,.99])assert.notEqual(q.target('b',1,true,random).id,'b')
 const p=track('p',{partCount:2});assert.equal(q.payload(p,false).collectionPlayback,true)
})
