import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const compiled=await build({stdin:{contents:"export * from './src/services/sourceTitles';export {fromStoredTrack,recordPlayedTrack} from './src/services/desktopApi';export {advanceAccountEpoch} from './src/services/accountScope'",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'title-boundaries',setup(b){
 b.onResolve({filter:/player\/playerStore$/},()=>({path:'store',namespace:'mock'}))
 b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'core',namespace:'mock'}))
 b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='store'?`export const usePlayerStore={getState:()=>globalThis.titleState,setState:patch=>Object.assign(globalThis.titleState,typeof patch==='function'?patch(globalThis.titleState):patch)};`:`export const isTauri=()=>true;export const invoke=(command,...args)=>command==='playlist_import_contexts'?Promise.resolve([]):globalThis.titleIpc(command,...args);`}))
}}]})
const module={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
const api=module.exports
const context={videoTitle:'AI喻大华 苦命皇帝咸丰 未删减版 01谁是太子',partTitle:'01谁是太子',partCount:1,season:{id:10,uploaderId:42,title:'AI喻大华 苦命皇帝咸丰 未删减版',uploaderName:'远哥挺乐',coverUrl:''}}
const stored={id:'bilibili:BV1234567890:1',bvid:'BV1234567890',cid:1,page:1,title:context.videoTitle,sourceDisplayTitle:context.videoTitle,sourceVideoTitle:context.videoTitle,sourceTitleContext:context,titleOverridden:false,durationSeconds:240,liked:true}
const old=()=>({...api.fromStoredTrack({...stored,sourceTitleContext:undefined}),sourceTitleContext:undefined})
const client={invalidateQueries:async()=>{}}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise}}

test('recording a play and reading a stored old title keep the short chapter and raw source',async()=>{
 globalThis.window=new EventTarget()
 let input
 globalThis.titleIpc=async(cmd,args)=>{assert.equal(cmd,'library_record_play');input=args.track;return stored}
 const short=api.fromStoredTrack(stored)
 const played=await api.recordPlayedTrack(short)
 assert.equal(played.title,'01谁是太子');assert.equal(played.videoTitle,context.videoTitle)
 assert.equal(input.sourceTitle,context.videoTitle);assert.deepEqual(input.sourceTitleContext,context)
 assert.equal(api.fromStoredTrack({...stored,title:'我的标题',titleOverridden:true}).displayTitle,'我的标题')
})

test('cache hydration repairs old queue and current titles without changing queue identity',async()=>{
 const track=old();globalThis.titleState={current:track,queue:[track]}
 globalThis.titleIpc=async(cmd)=>{assert.equal(cmd,'sync_current_track');return stored}
 await api.hydrateSourceTitles([track.id],client,true)
 assert.equal(titleState.current.title,'01谁是太子');assert.equal(titleState.queue[0].title,'01谁是太子');assert.equal(titleState.current.id,track.id)
})

test('late source cache responses cannot undo a new edit or an account ABA',async()=>{
 globalThis.window=new EventTarget()
 for(const change of ['edit','cover','account']) {
  const track=old(),pending=deferred();globalThis.titleState={current:track,queue:[track]}
  globalThis.titleIpc=()=>pending.promise
  const work=api.hydrateSourceTitles([track.id],client,true)
  if(change==='edit'){const edited={...track,title:'刚刚改名',displayTitle:'刚刚改名',titleOverridden:true};titleState.current=edited;titleState.queue=[edited]}
  else if(change==='cover'){const edited={...track,coverUrl:'https://custom.test/new.jpg'};titleState.current=edited;titleState.queue=[edited]}
  else{api.advanceAccountEpoch();api.advanceAccountEpoch()}
  pending.resolve(stored);await work
  assert.equal(titleState.current.title,change==='edit'?'刚刚改名':track.title)
  if(change==='cover')assert.equal(titleState.current.coverUrl,'https://custom.test/new.jpg')
 }
})

test('current song outside the queue is repaired and a failed stored read preserves cached text',async()=>{
 const track=old();globalThis.titleState={current:track,queue:[]}
 globalThis.titleIpc=async()=>stored
 await api.hydrateSourceTitles([track.id],client,true)
 assert.equal(titleState.current.title,'01谁是太子');assert.deepEqual(titleState.queue,[])
 globalThis.titleState={current:track,queue:[track]}
 let calls=0;globalThis.titleIpc=async()=>{calls++;throw new Error('database unavailable')}
 await api.hydrateSourceTitles([track.id],client,true)
 assert.equal(calls,1);assert.equal(titleState.current,track)
})

test('source hydration repairs legacy first-frame artwork in unsaved queues and preserves custom artwork',async()=>{
 for(const coverUrl of ['http://bili.test/first.jpg','https://music.test/album.jpg']) {
  const track={...old(),coverUrl};globalThis.titleState={current:track,queue:[track]}
  globalThis.titleIpc=async cmd=>cmd==='sync_current_track'?null:{bvid:track.source.bvid,title:context.videoTitle,coverUrl:'https://bili.test/cover.jpg',parts:[{cid:track.source.cid,page:1,title:context.partTitle,durationSeconds:240,coverUrl:'https://bili.test/cover.jpg',firstFrameUrl:'https://bili.test/first.jpg'}]}
  await api.hydrateSourceTitles([track.id],client,true)
  const expected=coverUrl.includes('first.jpg')?'https://bili.test/cover.jpg':coverUrl
  assert.equal(titleState.current.coverUrl,expected);assert.equal(titleState.queue[0].coverUrl,expected)
 }
})
