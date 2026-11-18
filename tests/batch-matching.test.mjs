import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const {outputFiles}=await build({entryPoints:['src/services/batchMatching.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'batch-ipc',setup(b){
 b.onResolve({filter:/@tauri-apps\/api\/core/},()=>({path:'ipc',namespace:'mock'}))
 b.onResolve({filter:/\/desktopApi$/},()=>({path:'api',namespace:'mock'}))
 b.onResolve({filter:/\/accountScope$/},()=>({path:'account',namespace:'mock'}))
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:a.path==='ipc'?`export const invoke=(...args)=>globalThis.api.invoke(...args)`:a.path==='account'?`export const accountEpoch=()=>globalThis.epoch`:`export const searchLyrics=(...args)=>globalThis.api.lyrics(...args);export const searchMetadataCatalog=(...args)=>globalThis.api.catalog(...args);export const getStoredLyrics=async()=>null;`}))
}}]})
const {matchTracksAutomatically,matchingMetadata}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const track={id:'bilibili:BV1GJ411x7h7:1',title:'王菲《红豆》',source:{provider:'bilibili',bvid:'BV1GJ411x7h7',cid:1,page:1},durationSeconds:240,liked:false}
const lyric={provider:'qq',id:1,trackName:'红豆',artistName:'王菲',albumName:'唱游',duration:240,instrumental:false,syncedLyrics:'[00:01]红豆'}
function reset(){globalThis.epoch=1;globalThis.window=new EventTarget();globalThis.writes=[];globalThis.api={invoke:async(c,a)=>{if(c==='batch_match_snapshot')return{session:'session-1',lyricToken:'token',protected:false};writes.push(a);return true},lyrics:async()=>({candidates:[lyric]}),catalog:async()=>[{trackId:'wrong',trackName:'红豆',artistName:'其他歌手',artworkUrl:'wrong'},{trackId:'qq:1',trackName:'红豆',artistName:'王菲',artworkUrl:'correct',collectionName:'唱游',source:'qq'}]}}
test('metadata derives from lyric identity; an unrelated catalog first result cannot win',()=>{const m=matchingMetadata(lyric,[{trackName:'红豆',artistName:'其他歌手',artworkUrl:'bad'},{trackId:'qq:1',trackName:'红豆',artistName:'王菲',artworkUrl:'good'}]);assert.equal(m.artist,'王菲');assert.equal(m.coverUrl,'good')})
test('batch deduplicates tracks and commits metadata and lyrics together with captured session/version',async()=>{reset();const states=[];const r=await matchTracksAutomatically([track,track],new AbortController().signal,p=>states.push(p));assert.equal(r.matched,1);assert.equal(r.total,1);assert.equal(writes.length,1);assert.equal(writes[0].metadata.coverUrl,'correct');assert.equal(writes[0].lyrics.providerLyricId,'1');assert.equal(writes[0].expectedSession,'session-1');assert.equal(writes[0].expectedLyricToken,'token')})
test('protected/manual items are skipped before any search',async()=>{reset();api.invoke=async()=>({session:'s',protected:true});api.lyrics=()=>{throw Error('must not search')};const r=await matchTracksAutomatically([track],new AbortController().signal,()=>{});assert.equal(r.skipped,1);assert.equal(writes.length,0)})
test('manual selection winning during search is not overwritten or counted as matched',async()=>{reset();const f=api.invoke;api.invoke=(c,a)=>c==='batch_match_commit'?false:f(c,a);const r=await matchTracksAutomatically([track],new AbortController().signal,()=>{});assert.equal(r.matched,0);assert.equal(r.skipped,1)})
test('cancellation and account ABA during search never commit a late pair',async()=>{for(const aba of [false,true]){reset();const ctrl=new AbortController();api.lyrics=async()=>{if(aba)epoch+=2;else ctrl.abort();return{candidates:[lyric]}};await assert.rejects(matchTracksAutomatically([track],ctrl.signal,()=>{}),{name:'AbortError'});assert.equal(writes.length,0)}})
test('missing optional catalog artwork does not discard an otherwise complete matching pair',async()=>{reset();let n=0;api.catalog=async()=>{if(!n++)throw Error('offline');return[]};const r=await matchTracksAutomatically([track,{...track,id:'other'}],new AbortController().signal,()=>{});assert.equal(r.failed,0);assert.equal(r.matched,2);assert.equal(writes.length,2);assert.equal(writes[0].metadata.album,'唱游');assert.equal(writes[0].metadata.coverUrl,undefined)})

test('provider cover wins; other albums and same-name editions do not supply artwork',()=>{
 const candidates=[{trackId:'qq:99',trackName:'红豆',artistName:'王菲',collectionName:'另一个专辑',artworkUrl:'wrong'}, {trackId:'qq:1',trackName:'红豆',artistName:'王菲',collectionName:'唱游',artworkUrl:'same-id'}]
 assert.equal(matchingMetadata(lyric,candidates.slice(0,1)).coverUrl,undefined)
 assert.equal(matchingMetadata({...lyric,artworkUrl:'original'},candidates).coverUrl,'original')
})
test('batch supplies uploader context and distinguishes failed providers from no match',async()=>{
 reset();let n=0;api.lyrics=async(title,artist,force,source)=>{assert.equal(source.uploaderName,'录音棚');return {candidates:[],warning:n++===0?'QQ 请求超时':undefined}}
 const input={...track,artist:'录音棚',source:{...track.source,uploaderName:'录音棚'}}
 const r=await matchTracksAutomatically([input,{...input,id:'other'}],new AbortController().signal,()=>{})
 assert.equal(r.failed,1);assert.equal(r.unmatched,1);assert.equal(writes.length,0)
})
