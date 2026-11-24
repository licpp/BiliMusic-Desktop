import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const compiled=await build({entryPoints:['src/features/player/preloadNextTrack.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'prefetch-fixture',setup(b){
 b.onResolve({filter:/playerStore$|desktopApi$|accountScope$|^@tauri-apps\/api\/core$/},a=>({path:a.path,namespace:'fixture'}))
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path.endsWith('playerStore')?'export const usePlayerStore={getState:()=>globalThis.prefetchFixture.state,subscribe(fn){const fixture=globalThis.prefetchFixture;fixture.listener=fn;return ()=>{fixture.listener=undefined}}};export const prepareSeasonQueueEntry=(t,current)=>globalThis.prefetchFixture.resolve(t,current)':path.endsWith('desktopApi')?'export const inDesktopShell=true':path.endsWith('accountScope')?'export const accountEpoch=()=>globalThis.prefetchFixture.epoch':'export const isTauri=()=>true;export const invoke=(...a)=>globalThis.prefetchFixture.calls.push(a)'}))
}}]})
function setup(extra={}){
 const track=i=>({id:`bilibili:BVtest:${i}`,source:{provider:'bilibili',bvid:'BVtest',cid:i}}),queue=[track(1),track(2),track(3)]
 const f=globalThis.prefetchFixture={state:{current:queue[0],queue,status:'playing',progressSeconds:0,durationSeconds:240,shuffled:false,repeatMode:'off',...extra},calls:[],epoch:0,timers:new Map(),resolve:async t=>t}
 let id=0;globalThis.window={setTimeout(fn){f.timers.set(++id,fn);return id},clearTimeout(i){f.timers.delete(i)}};globalThis.document=new EventTarget()
 const module={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);f.stop=module.exports.startPreloadingNextTrack()
 f.update=patch=>{const previous=f.state;f.state={...f.state,...patch};f.listener?.(f.state,previous)}
 f.fire=async()=>{for(const [i,fn]of f.timers){f.timers.delete(i);fn()}await new Promise(setImmediate)}
 return f
}
test('only one predictable next track is warmed after playback settles, including background views',async()=>{
 const f=setup();assert.equal(f.timers.size,0);document.hidden=true
 f.update({progressSeconds:3});await f.fire();assert.deepEqual(f.calls,[['bili_warm_playback',{bvid:'BVtest',cid:2}]])
 f.update({progressSeconds:4});await f.fire();assert.equal(f.calls.length,1)
})
test('pause, shuffle and repeat-one cancel scheduled prefetch',async()=>{
 for(const patch of [{status:'paused'},{shuffled:true},{repeatMode:'one'}]){
  const f=setup({progressSeconds:3});assert.equal(f.timers.size,1);f.update(patch);await f.fire();assert.equal(f.calls.length,0)
 }
})
test('late season resolution cannot warm the wrong queue or account',async()=>{
 for(const change of [f=>f.update({current:f.state.queue[2]}),f=>f.epoch++]){
  const f=setup({progressSeconds:3});f.state.queue[1].resolveParts=true;let release;f.resolve=()=>new Promise(r=>release=r)
  await f.fire();change(f);release({source:{provider:'bilibili',bvid:'BVlate',cid:9}});await new Promise(setImmediate);assert.equal(f.calls.length,0)
 }
})
test('disposing prefetch releases subscriptions and prevents a late resolution from warming media', async () => {
 const f = setup({progressSeconds:3})
 f.state.queue[1].resolveParts = true
 let reply, isCurrent
 f.resolve = (_entry, current) => new Promise(resolve => { reply = resolve; isCurrent = current })
 await f.fire()
 f.stop()
 assert.equal(f.listener, undefined)
 assert.equal(isCurrent(), false)
 reply({source:{provider:'bilibili',bvid:'BVlate',cid:9}})
 await new Promise(resolve => setImmediate(resolve))
 document.dispatchEvent(new Event('visibilitychange'))
 assert.equal(f.calls.length, 0)
 assert.equal(f.timers.size, 0)
})
