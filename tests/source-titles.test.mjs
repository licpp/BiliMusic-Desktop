import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const compiled=await build({entryPoints:['src/services/sourceTitles.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'source-fixture',setup(b){
 b.onResolve({filter:/playerStore$|desktopApi$|accountScope$|^@tauri-apps\/api\/core$/},a=>({path:a.path,namespace:'fixture'}))
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path.endsWith('playerStore')?'export const usePlayerStore={getState:()=>globalThis.titleFixture.state,setState:fn=>{Object.assign(globalThis.titleFixture.state,fn(globalThis.titleFixture.state));globalThis.titleFixture.writes++}}':path.endsWith('desktopApi')?'export const inDesktopShell=true;export const fromStoredTrack=t=>t;export const getVideoParts=async()=>globalThis.titleFixture.detail':path.endsWith('accountScope')?'export const accountEpoch=()=>globalThis.titleFixture.epoch':'export const invoke=(...a)=>globalThis.titleFixture.invoke(...a)'}))
}}]})
function setup(invoke, captureSession = async () => 'native-session'){
 const old={id:'bilibili:BVtest:1',title:'视频 + 分P',source:{provider:'bilibili',bvid:'BVtest',cid:1}}
 const f=globalThis.titleFixture={
  state:{queue:[old],current:old},epoch:0,writes:0,invalidations:[],
  invoke:(command, args)=>command==='account_session'?captureSession():invoke(command, args),
 }
 const module={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
 f.hydrate=()=>module.exports.hydrateSourceTitles([old.id],{invalidateQueries:async a=>f.invalidations.push(a)})
 return f
}
test('fresh database metadata still repairs a stale restored queue without another source fetch',async()=>{
 const f=setup(async (command,args)=>{
  if(command==='sync_hydrate_sources'){
   assert.deepEqual(args,{titleIds:['bilibili:BVtest:1'],expectedAccountSession:'native-session'})
   return 0
  }
  return {id:'bilibili:BVtest:1',title:'手动名称',displayTitle:'分P名称',source:{provider:'bilibili'}}
 })
 await f.hydrate();assert.equal(f.state.queue[0].displayTitle,'分P名称');assert.equal(f.state.current.displayTitle,'分P名称');assert.equal(f.writes,1);assert.deepEqual(f.invalidations.map(a=>a.queryKey[0]),['listening-statistics','library','home-recent','list-preferences'])
 await f.hydrate();assert.equal(f.writes,1,'the attempt throttle must not emit repeated queue writes')
})
test('late source cache reads cannot update another account queue',async()=>{
 let release
 const f=setup(command=>command==='sync_hydrate_sources'?0:new Promise(resolve=>release=resolve))
 const pending=f.hydrate();await new Promise(setImmediate);f.epoch++;release({id:'bilibili:BVtest:1',displayTitle:'旧账号'})
 await pending;assert.equal(f.writes,0);assert.equal(f.state.current.title,'视频 + 分P')
})

test('an account switch while obtaining the native session skips hydration dispatch',async()=>{
 let release
 const calls=[]
 const f=setup(async command=>calls.push(command),()=>new Promise(resolve=>release=resolve))
 const pending=f.hydrate()
 f.epoch+=2
 release('current-native-session')
 await pending
 assert.deepEqual(calls,[])
 assert.equal(f.writes,0)
})

test('search-only restored queue resolves exact CID without requiring a saved library row',async()=>{
 const f=setup(async command=>command==='sync_hydrate_sources'?0:null)
 f.detail={bvid:'BVtest',title:'BV 标题',parts:[{cid:1,page:1,title:'分P一',durationSeconds:100},{cid:2,page:2,title:'分P二',durationSeconds:100}]}
 await f.hydrate();assert.equal(f.state.queue[0].displayTitle,'分P一');assert.equal(f.state.current.partCount,2)
})
test('single-part queue displays BV title even when P1 title differs',async()=>{
 const f=setup(async command=>command==='sync_hydrate_sources'?0:null)
 f.detail={bvid:'BVtest',title:'BV 标题',parts:[{cid:1,page:1,title:'旧分P名称',durationSeconds:100}]}
 await f.hydrate();assert.equal(f.state.queue[0].displayTitle,'BV 标题')
})
