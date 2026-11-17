import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import {importEntryCommand} from './fixtures/import-entry-store.mjs'
const compiled=await build({stdin:{contents:`export * from './src/services/playlistImport';export * from './src/services/importedEntries';export * from './src/services/playlistImportModel';export * from './src/services/externalSongMatch';export * from './src/domain/songIdentity'`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'adapters',setup(b){
 b.onResolve({filter:/\/desktopApi$|\/accountScope$|^@tauri-apps\/api\/core$/},args=>({path:args.path,namespace:'fixture'}))
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path.endsWith('desktopApi')?`export const inDesktopShell=true;export const searchBilibili=(...args)=>window.f.search(...args);export const getVideoParts=(...args)=>window.f.detail(...args);export const listPlaylistTracks=async()=>window.f.tracks||[];export const commandErrorMessage=e=>e.message||String(e);`:path.endsWith('accountScope')?`export const accountEpoch=()=>window.f.epoch;`:`export const invoke=(command,args)=>window.f.invoke(command,args);`}))
}}]})
const bv='BV1GJ411x7h7',other='BV1Wr4218772'
const song={sourceId:'qq:1',title:'再遇见 (苏打绿版)',artists:['苏打绿'],durationSeconds:277}
const item=(bvid=bv,title='苏打绿《再遇见》',playCount=1000)=>({bvid,title,uploaderId:7,uploaderName:'UP',durationSeconds:277,coverUrl:'https://fixture/cover',playCount,description:''})
const video=(bvid=bv)=>({...item(bvid),aid:1,parts:[{cid:1,page:1,title:'再遇见',durationSeconds:277,coverUrl:''}]})
function setup(){
 const window=new EventTarget(),f=window.f={epoch:0,scope:'account:1',commits:[],queries:[],reads:[],tracks:[]}
 f.search=async(query,page)=>{f.queries.push([query,page]);return {items:[item()],page,pageSize:20,total:40}}
 f.detail=async bvid=>{f.reads.push(bvid);return video(bvid)}
 f.invoke=async(command,args)=>{if(command==='playlist_import_scope')return f.scope;const result=importEntryCommand(f,command,args);if(result!==undefined)return result;throw Error(command)}
 let tick=1_000_000
 class Clock extends Date{static now(){return tick+=30_000}}
 const module={exports:{}}
 new Function('require','module','exports','window','Date',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports,window,Clock)
 return {...module.exports,window,f}
}
const choice=(title='苏打绿《再遇见》',durationSeconds=277,extra={})=>({track:{id:`bilibili:${bv}:${extra.cid||1}`,source:{provider:'bilibili',bvid:bv,cid:extra.cid||1,page:1},title,durationSeconds,liked:false},evidence:{bvid:bv,cid:1,title,durationSeconds,partCount:1,detailsVerified:true,...extra}})

test('screenshot/noisy-caption samples use production identity/ranking without fabricating network recall',async()=>{
 const a=setup(),fixture=JSON.parse(await readFile(new URL('./fixtures/playlist-match-cases.json',import.meta.url),'utf8'))
 const samples=Array.isArray(fixture)?fixture:fixture.cases
 for(const sample of samples){
   const source={sourceId:'fixture',title:sample.title,artists:sample.artists,durationSeconds:sample.durationSeconds}
   const actual=a.chooseImportMatch(source,[choice(sample.candidate,sample.actualSeconds)])
   if(!sample.accept)assert.equal(actual,undefined,sample.title)
   else assert.ok(actual,sample.title)

 }
})
test('known singer suffix normalizes on both catalog and video sides; edition suffixes remain meaningful',()=>{
 const a=setup()
 assert.ok(a.chooseImportMatch(song,[choice()]))
 assert.ok(a.chooseImportMatch({...song,title:'再遇见'},[choice('苏打绿《再遇见 (苏打绿版)》')]))
 assert.equal(a.chooseImportMatch({...song,title:'再遇见 (钢琴版)'},[choice()]),undefined)
 assert.equal(a.chooseImportMatch({...song,title:'再遇见 (Live)'},[choice()]),undefined)
 assert.equal(a.importKeyword(song),'再遇见 苏打绿')
})
test('MV intro/outro is soft duration evidence, but unrelated song and gross duration mismatch are rejected',()=>{
 const a=setup()
 assert.ok(a.chooseImportMatch(song,[choice(undefined,297)]))
 assert.equal(a.chooseImportMatch(song,[choice(undefined,100)]),undefined)
 assert.equal(a.chooseImportMatch(song,[choice('苏打绿《小情歌》')]),undefined)
 const correct=choice(undefined,280,{playCount:1000}),wrong=choice('苏打绿《再遇见》翻唱',277,{cid:2,playCount:1e10})
 assert.equal(a.chooseImportMatch(song,[wrong,correct]),correct)
 const low=choice(undefined,277,{cid:3,playCount:100}),high=choice(undefined,277,{cid:4,playCount:1e6})
 const ranked=a.rankImportSongCandidates(song,[low.evidence,high.evidence]).ranked
 assert.equal(ranked[0].candidate.cid,4);assert.ok(ranked[0].popularityScore<=12)
})
test('normal manual search preserves API order and pagination without reading/filtering details',async()=>{
 const a=setup()
 a.f.search=async(q,page)=>{a.f.queries.push([q,page]);return {items:[item(other,'完全不同的歌',10),item(bv,'再遇见',1e7)],page,pageSize:20,total:60}}
 const one=await a.searchReplacementVideos('任意关键字',1,new AbortController().signal)
 const two=await a.searchReplacementVideos('任意关键字',2,new AbortController().signal)
 assert.deepEqual(one.items.map(i=>i.bvid),[other,bv]);assert.equal(two.page,2)
 assert.equal(one.items[0].coverUrl,'https://fixture/cover');assert.equal(one.items[1].playCount,1e7)
 assert.deepEqual(a.f.queries,[['任意关键字',1],['任意关键字',2]]);assert.deepEqual(a.f.reads,[])
})
test('reported songs prefer a popular correct MV or studio upload over exact-duration cold recordings',()=>{
 const a=setup()
 for(const sample of [
  {title:'夜航星',artists:['不才','三无'],durationSeconds:240,hot:'【官方MV】不才 / 三无《夜航星》'},
  {title:'红莲华',artists:['LiSA'],durationSeconds:240,hot:'LiSA「紅蓮華」Official MV'},
  {title:'呓语',artists:['毛不易'],durationSeconds:240,hot:'在百万豪装录音棚大声听毛不易《呓语》'},
 ]){
  const cold=choice(`${sample.artists.join(' / ')}《${sample.title}》录屏`,240,{cid:10,playCount:30})
  const hot=choice(sample.hot,258,{cid:11,playCount:3e6})
  assert.equal(a.chooseImportMatch(sample,[cold,hot]),hot,sample.title)
  const wrong=choice(`${sample.artists.join(' / ')}《${sample.title}》翻唱`,240,{cid:12,playCount:1e10})
  assert.equal(a.chooseImportMatch(sample,[wrong,cold,hot]),hot,sample.title)
 }
})
test('public 红莲华 MV caption with an anime name is not a medley; Japanese covers remain different editions',()=>{
 const a=setup(),source={title:'红莲华',artists:['LiSA'],durationSeconds:237}
 // Public search captions checked 2026-11-17, BV1nZ421z7t1 / BV1UTKBz9Eog.
 const mv=choice('【LiSA】《紅蓮華》音乐MV（动画《鬼灭之刃 灶门炭治郎 立志篇》片头曲）',236,{cid:20,playCount:52000})
 const studio=choice('LiSA《紅蓮華》百万豪装录音棚大声听',237,{cid:21,playCount:1486000})
 assert.ok(a.chooseImportMatch(source,[mv]))
 assert.equal(a.chooseImportMatch(source,[mv,studio]),studio)
 assert.equal(a.chooseImportMatch(source,[choice('LiSA『紅蓮華』歌ってみた！',237,{playCount:1e8})]),undefined)
 assert.equal(a.chooseImportMatch(source,[choice('LiSA《紅蓮華》《炎》串烧',237)]),undefined)
})
test('automatic matching compares the shortlist rather than returning the first acceptable detail',async()=>{
 const a=setup(),third='BV1Xt4y1m7v3'
 a.f.search=async()=>({items:[item(bv,'苏打绿《再遇见》',20),item(other,'苏打绿《再遇见》官方MV',2e6),item(third,'苏打绿《再遇见》',5e5)]})
 a.f.detail=async bvid=>{a.f.reads.push(bvid);return {...video(bvid),title:bvid===other?'苏打绿《再遇见》官方MV':'苏打绿《再遇见》',playCount:bvid===other?2e6:20,parts:[{cid:1,page:1,title:'再遇见',durationSeconds:bvid===other?292:277}]}}
 const found=await a.findImportCandidates(song,new AbortController().signal)
 assert.equal(found[0].track.source.bvid,other)
 assert.equal(a.f.reads.length,3)
})
test('a cold first-query match still searches the title-only fallback and keeps the more popular correct result',async()=>{
 const a=setup();a.f.search=async q=>({items:[item(q===a.importKeyword(song)?bv:other,'苏打绿《再遇见》',q===a.importKeyword(song)?10:1e6)]})
 a.f.detail=async bvid=>({...video(bvid),playCount:bvid===bv?10:1e6})
 const found=await a.findImportCandidates(song,new AbortController().signal)
 assert.equal(found[0].track.source.bvid,other)
})
test('unknown multipart total duration cannot remove a correct part before detail resolution',async()=>{
 const a=setup()
 a.f.search=async()=>({items:[{...item(),durationSeconds:12000}]})
 a.f.detail=async bvid=>{a.f.reads.push(bvid);return {...video(bvid),title:'苏打绿全集',parts:[{cid:1,page:1,title:'小情歌',durationSeconds:277},{cid:2,page:2,title:'再遇见',durationSeconds:277}]}}
 const found=await a.findImportCandidates(song,new AbortController().signal)
 assert.equal(found.length,1);assert.equal(found[0].track.source.cid,2);assert.deepEqual(a.f.reads,[bv])
})
test('BV/link search resolves metadata and exposes all valid parts without guessing P1',async()=>{
 const a=setup()
 a.f.detail=async bvid=>({...video(bvid),parts:[{cid:1,page:1,title:'不同的歌',durationSeconds:123},{cid:2,page:2,title:'再遇见',durationSeconds:277},{cid:0,page:3,title:'invalid',durationSeconds:0}]})
 const page=await a.searchReplacementVideos(`https://www.bilibili.com/video/${bv}/`,1,new AbortController().signal)
 assert.equal(page.items[0].bvid,bv);assert.equal(a.f.queries.length,0)
 const parts=await a.resolveReplacementVideo(bv,new AbortController().signal)
 assert.deepEqual(parts.map(c=>c.track.source.cid),[1,2])
})
test('search and detail discard canceled and ABA account responses',async()=>{
 for(const kind of ['search','detail']){
  const a=setup();let finish,entered
  const began=new Promise(resolve=>entered=resolve)
  const delayed=()=>{entered();return new Promise(resolve=>finish=resolve)}
  if(kind==='search')a.f.search=delayed;else a.f.detail=delayed
  const abort=new AbortController(),request=kind==='search'?a.searchReplacementVideos('词',1,abort.signal):a.resolveReplacementVideo(bv,abort.signal)
  await began;a.f.epoch+=2;finish(kind==='search'?{items:[item()]}:video())
  await assert.rejects(request,e=>e.name==='AbortError')
 }
})
test('concurrent manual selection wins over a delayed auto result without overwriting or marking it missing',async()=>{
 const a=setup();await a.bootPlaylistImport();a.newPlaylistImport({name:'test',source:'qq',songs:[song]},'test')
 let finish,entered;const began=new Promise(resolve=>entered=resolve)
 a.f.detail=()=>{entered();return new Promise(resolve=>finish=resolve)}
 const run=a.runPlaylistImport();await began
 const job=a.usePlaylistImport.getState().job,snapshot=await a.loadImportedEntries(job.playlistId)
 const manual={...choice(),track:{...choice().track,id:`bilibili:${other}:9`,source:{provider:'bilibili',bvid:other,cid:9,page:1}}}
 await a.replaceImportedEntry(snapshot.entries[0],manual,snapshot.session)
 finish(video());await run
 const canonical=await a.loadImportedEntries(job.playlistId)
 assert.equal(canonical.entries[0].trackId,manual.track.id)
 assert.equal(canonical.entries[0].mode,'manual');assert.equal(a.f.commits.length,1)
 assert.equal(a.usePlaylistImport.getState().job.rows[0].status,'saved')
 assert.equal(a.usePlaylistImport.getState().job.state,'paused')
})
test('only missing entries retry and a single-entry retry leaves every other missing entry untouched',async()=>{
 const a=setup();await a.bootPlaylistImport()
 const playlist={id:'import:retry',name:'retry',isSystem:false}
 let snapshot=await a.seedImportedEntries(playlist.id,playlist.name,'qq',[{order:0,song},{order:1,song:{...song,sourceId:'2'}},{order:2,song:{...song,sourceId:'3'}}])
 await a.replaceImportedEntry(snapshot.entries[0],choice(),snapshot.session)
 snapshot=await a.loadImportedEntries(playlist.id)
 a.f.detail=async bvid=>({...video(bvid),parts:[{cid:2,page:1,title:'再遇见',durationSeconds:277}]})
 await a.retryMissingImportedPlaylist(playlist,snapshot.entries[1].entryId)
 snapshot=await a.loadImportedEntries(playlist.id)
 assert.equal(snapshot.entries[0].trackId,choice().track.id)
 assert.equal(snapshot.entries[1].trackId,`bilibili:${bv}:2`)
 assert.equal(snapshot.entries[2].trackId,undefined)
 assert.deepEqual(a.f.queries.map(q=>q[0]),[a.importKeyword(song),a.importKeyword(song,true)])
})
test('two imported originals targeting one video retain the later row as an explicit missing entry',async()=>{
 const a=setup();await a.bootPlaylistImport();a.newPlaylistImport({name:'same',source:'qq',songs:[song,{...song,sourceId:'second'}]},'same')
 await a.runPlaylistImport()
 const job=a.usePlaylistImport.getState().job,snapshot=await a.loadImportedEntries(job.playlistId)
 assert.equal(snapshot.entries.length,2);assert.equal(snapshot.entries[0].trackId,choice().track.id);assert.equal(snapshot.entries[1].trackId,undefined)
 assert.equal(job.rows[1].status,'missing');assert.match(job.rows[1].message,/另一首/)
})

test('pause while loading canonical entries cannot later seed a canceled import',async()=>{
 const a=setup();await a.bootPlaylistImport();a.newPlaylistImport({name:'old',source:'qq',songs:[song]},'old')
 const invoke=a.f.invoke;let finish,entered,seedCalls=0
 const began=new Promise(resolve=>entered=resolve)
 a.f.invoke=async(command,args)=>{
  if(command==='playlist_import_entries'){entered();return new Promise(resolve=>finish=resolve)}
  if(command==='playlist_import_seed')seedCalls++
  return invoke(command,args)
 }
 const run=a.runPlaylistImport();await began
 a.pausePlaylistImport();a.newPlaylistImport({name:'new',source:'qq',songs:[song]},'new')
 finish({session:a.f.scope,entries:[]});await run
 assert.equal(seedCalls,0);assert.equal(a.usePlaylistImport.getState().job.name,'new');assert.equal(a.usePlaylistImport.getState().job.state,'ready')
})
test('failed manual binding preserves the old source and does not globally rewrite metadata',async()=>{
 const a=setup(),playlist='import:failed'
 const snapshot=await a.seedImportedEntries(playlist,'failed','qq',[{order:0,song}])
 const first=await a.replaceImportedEntry(snapshot.entries[0],choice(),snapshot.session)
 const bad={...choice(),track:{...choice().track,id:`bilibili:${other}:2`,source:{provider:'bilibili',bvid:other,cid:2,page:1}}}
 const invoke=a.f.invoke
 a.f.invoke=async(command,args)=>{if(command==='playlist_import_bind')throw Error('disk full');return invoke(command,args)}
 await assert.rejects(a.replaceImportedEntry(first.entries[0],bad,first.session),/disk full/)
 assert.equal((await a.loadImportedEntries(playlist)).entries[0].trackId,choice().track.id)
 assert.equal(a.f.commits.length,1);assert.equal(a.f.commits[0].entries[0].metadata,undefined)
})
test('explicit artist conflicts and embedded short titles cannot become automatic matches',()=>{
 const a=setup()
 assert.equal(a.chooseImportMatch({...song,title:'十年',artists:['陈奕迅'],durationSeconds:205},[choice('陈奕迅这十年的回顾',205)]),undefined)
 assert.equal(a.chooseImportMatch({...song,title:'Beautiful Song',artists:['Artist'],durationSeconds:205},[choice('OtherArtist - Beautiful Song',205)]),undefined)
})
test('single-part placeholder title cannot hide the actual BV title, while a medley is not a song identity',async()=>{
 const a=setup()
 a.f.detail=async bvid=>({...video(bvid),parts:[{cid:1,page:1,title:'P1',durationSeconds:277}]})
 const found=await a.findImportCandidates(song,new AbortController().signal)
 assert.equal(found.length,1)
 assert.equal(a.chooseImportMatch(song,[choice('苏打绿《再遇见》《小情歌》串烧',277)]),undefined)
})
