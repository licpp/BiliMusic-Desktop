import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const compiled = await build({stdin:{contents:`export * from './src/domain/sourceTitle';export * from './src/domain/importedPresentation';export {listPlaylistTracks,recordPlayedTrack} from './src/services/desktopApi';export {hydrateSourceTitles} from './src/services/sourceTitles';export {refreshImportedPlayback} from './src/services/importedPlayback';export {nativeQueueEnvelope} from './src/features/player/nativeQueue'`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'presentation-boundaries',setup(b){
  b.onResolve({filter:/player\/playerStore$/},()=>({path:'store',namespace:'fixture'}))
  b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'ipc',namespace:'fixture'}))
  b.onResolve({filter:/\/accountScope$/},()=>({path:'account',namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='ipc'?`export const isTauri=()=>true;export const invoke=(command,...args)=>command==='playlist_import_contexts'?Promise.resolve(globalThis.f.contexts||[]):globalThis.f.invoke(command,...args);export class Channel {}`:path==='account'?`export const accountEpoch=()=>globalThis.f.epoch;`:`export const playbackIntent=()=>globalThis.f.intent;export const usePlayerStore={getState:()=>globalThis.f.state,setState:p=>Object.assign(globalThis.f.state,typeof p==='function'?p(globalThis.f.state):p)};`}))
}}]})
const m={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports);const a=m.exports
const id='bilibili:BV1GJ411x7h7:1', context={videoTitle:'毛不易《呓语》录屏',partTitle:'P1',partCount:1}
const stored={id,bvid:'BV1GJ411x7h7',cid:1,page:1,title:context.videoTitle,sourceDisplayTitle:context.videoTitle,sourceVideoTitle:context.videoTitle,sourceTitleContext:context,titleOverridden:false,coverUrl:'https://bili.test/cover',durationSeconds:240,liked:false}
const entry={entryId:'entry:1',playlistId:'import:test',order:0,trackId:id,revision:'r1',song:{sourceId:'qq:1',title:'呓语',artists:['毛不易'],album:'小王',coverUrl:'https://music.test/album'}}
const raw=()=>({id,source:{provider:'bilibili',bvid:stored.bvid,cid:1,page:1},title:stored.title,displayTitle:stored.title,coverUrl:stored.coverUrl,sourceTitleContext:context,durationSeconds:240,liked:false,importedEntry:entry})
function reset(){globalThis.window=new EventTarget();globalThis.f={epoch:1,intent:1,state:{queue:[],queueBase:[],current:null,status:'paused',play:async()=>{}},invoke:async command=>command==='playlist_import_entries'?{session:'s',entries:[entry]}:command==='playlist_tracks'?[stored]:command==='account_session'?'s':stored}}
test('playlist, player and restored queue share catalog presentation but recording writes source metadata',async()=>{
 reset();const [track]=await a.listPlaylistTracks(entry.playlistId)
 assert.equal(track.id,id);assert.equal(track.title,'呓语');assert.equal(track.coverUrl,entry.song.coverUrl);assert.equal(track.artist,'毛不易')
 assert.equal(track.titleOverridden,false)
 assert.equal(JSON.stringify(a.withTrackTitle(JSON.parse(JSON.stringify(track)))),JSON.stringify(track))
 let recorded;f.invoke=async(command,args)=>{recorded=args.track;return stored}
 const played=await a.recordPlayedTrack(track)
 assert.equal(played.title,'呓语');assert.equal(played.album,'小王');assert.equal(played.coverUrl,entry.song.coverUrl)
 assert.equal(recorded.title,stored.title);assert.equal(recorded.coverUrl,stored.coverUrl);assert.equal(recorded.artist,undefined)
 assert.equal(recorded.importedEntry,undefined);assert.equal(recorded.importedSourceMetadata,undefined)
})
test('source hydration keeps current/queue catalog views separate even for the same BVID + CID',async()=>{
 reset();const first=a.withTrackTitle(raw()),second=a.withTrackTitle({...raw(),importedEntry:{...entry,playlistId:'import:other',song:{...entry.song,title:'另一歌单名称',coverUrl:'https://music.test/other'}}})
 f.state={queue:[first],current:second};let reads=0;f.invoke=async()=>{reads++;return stored}
 await a.hydrateSourceTitles([id],{invalidateQueries:async()=>{}},true)
 assert.equal(reads,1);assert.equal(f.state.queue[0].title,'呓语');assert.equal(f.state.current.title,'另一歌单名称');assert.equal(f.state.current.coverUrl,'https://music.test/other')
})
test('an old queue without presentation recovers an unambiguous local imported binding',async()=>{
 reset();f.contexts=[entry];const track={...raw(),importedEntry:undefined};f.state={queue:[track],current:track}
 await a.hydrateSourceTitles([id],{invalidateQueries:async()=>{}},true)
 assert.equal(f.state.current.title,'呓语');assert.equal(f.state.current.coverUrl,entry.song.coverUrl)
})
test('legacy context recovery cannot apply an earlier account response to a new session',async()=>{
 reset();let resolve;f.contexts=new Promise(r=>resolve=r);const track={...raw(),importedEntry:undefined};f.state={queue:[track],current:track}
 const loading=a.hydrateSourceTitles([id],{invalidateQueries:async()=>assert.fail('stale account invalidation')},true)
 f.epoch++;const next={...track,title:'新账号'};f.state={queue:[next],current:next};resolve([entry]);await loading
 assert.equal(f.state.current,next);assert.equal(f.state.queue[0],next)
})
test('manual metadata remains authoritative and an entry cannot present a different video',()=>{
 reset();const track=a.withTrackTitle({...raw(),titleOverridden:true,title:'我的标题',coverUrl:'https://custom.test/image'})
 assert.equal(track.title,'我的标题');assert.equal(track.coverUrl,'https://custom.test/image')
 assert.equal(a.withTrackTitle({...raw(),importedEntry:{...entry,trackId:'other'}}).title,stored.title)
})
test('native queues carry source records and playlist context rather than overwriting source metadata',async()=>{
 reset();const envelope=await a.nativeQueueEnvelope([a.withTrackTitle(raw())],'all',false,0)
 assert.equal(envelope.tracks[0].title,stored.title);assert.equal(envelope.tracks[0].coverUrl,stored.coverUrl);assert.equal(envelope.tracks[0].importedEntry.entryId,entry.entryId)
})
test('source replacement updates the same queue slot/current immediately; paused playback stays paused',()=>{
 for(const playing of [false,true]){
  reset();const track=a.withTrackTitle(raw()),other={...track,id:'unrelated',importedEntry:undefined}
  let starts=0;f.state={queue:[other,track],queueBase:[other,track],current:track,status:playing?'playing':'paused',progressSeconds:100,play:async t=>{starts++;assert.equal(t.source.cid,2);f.state.current=t;f.state.progressSeconds=0}}
  const next={...raw(),id:'bilibili:BV1GJ411x7h7:2',source:{...raw().source,cid:2},importedEntry:undefined},updated={...entry,trackId:next.id,revision:'r2'}
  a.refreshImportedPlayback(entry,{track:next},{session:'s',entries:[updated]},1)
  assert.equal(f.state.queue[1].id,next.id);assert.equal(f.state.queueBase[1].id,next.id);assert.equal(f.state.current.title,'呓语');assert.equal(f.state.current.coverUrl,entry.song.coverUrl);assert.equal(f.state.progressSeconds,0);assert.equal(starts,playing?1:0)
  assert.equal(f.state.queue[0].id,'unrelated')
 }
})
test('a completed replacement cannot hijack a newer play intent or another playlist with the same video',()=>{
 reset();const track=a.withTrackTitle(raw()),another=a.withTrackTitle({...raw(),importedEntry:{...entry,playlistId:'import:other'}})
 f.state={queue:[track,another],queueBase:[track,another],current:another,status:'playing',play:()=>assert.fail('late write took over playback')};f.intent=3
 const next={...raw(),id:'new',importedEntry:undefined},updated={...entry,trackId:'new'}
 a.refreshImportedPlayback(entry,{track:next},{session:'s',entries:[updated]},1)
 assert.equal(f.state.current,another);assert.equal(f.state.queue[1],another);assert.equal(f.state.queue[0].id,'new')
})
test('replacing with a video already in the queue retains the entry slot without duplicate source IDs',()=>{
 reset();const track=a.withTrackTitle(raw()),next={...raw(),id:'new',importedEntry:undefined},other={...raw(),id:'other',importedEntry:undefined}
 f.state={queue:[next,other,track],queueBase:[track,other,next],current:other,status:'paused'}
 a.refreshImportedPlayback(entry,{track:next},{session:'s',entries:[{...entry,trackId:'new'}]},1)
 assert.deepEqual(f.state.queue.map(t=>t.id),['other','new']);assert.deepEqual(f.state.queueBase.map(t=>t.id),['new','other']);assert.equal(f.state.current,other)
})
