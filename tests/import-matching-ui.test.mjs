import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {build} from 'esbuild'
const require=createRequire(import.meta.url)
const {QueryClient,QueryClientProvider}=require('@tanstack/react-query')
const result=await build({stdin:{contents:`export {LibraryView} from './src/features/library/LibraryView';export {PlaylistMenu} from './src/features/library/PlaylistEntry';export {ReplacementSearch,formatMatchPlayCount} from './src/features/library/ReplacementDialog';export {ImportedPlaylistCompletionContent} from './src/features/library/ImportedPlaylistCompletion';export {accountQueryKey} from './src/services/queryKeys'`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime','@tanstack/react-query'],loader:{'.css':'empty'},plugins:[{name:'ui-boundaries',setup(b){
const mocks={
 playerStore:`export const playbackIntent=()=>0;export const usePlayerStore=fn=>fn({current:null});usePlayerStore.getState=()=>({});`,
 playlistImport:`export const usePlaylistImport=fn=>fn({job:globalThis.importUiJob||null});export const pausePlaylistImport=()=>{};export const retryMissingImportedPlaylist=async()=>{};export const searchReplacementVideos=async()=>({items:[],page:1,pageSize:20,total:0});export const resolveReplacementVideo=async()=>[];`,
 importedEntries:`export const loadImportedEntries=async()=>({session:'test',entries:[]});export const replaceImportedEntry=async()=>({session:'test',entries:[]});export const removeUnmatchedImportedEntry=async()=>({session:'test',entries:[]});`,
 useCompactLayout:`export const useCompactLayout=()=>false`,
 useLocateCurrentRow:`export const useLocateCurrentRow=()=>{}`,
 sourceTitles:`export const hydrateSourceTitles=async()=>{}`,
 sync:`export const hydrateVisibleTracks=async()=>{}`,
 TrackMenuButton:`import {createElement} from 'react';export const TrackMenuButton=p=>createElement('button',{'data-track-menu':p.track.id,'data-can-replace':Boolean(p.actions?.replaceVideo)},'更多操作')`,
 DownloadsView:`export const DownloadsView=()=>null`,
 ListSort:`export const ListSort=()=>null;export const useListSort=()=>({rule:'source:asc',dates:{},playCounts:{}})`,
 useTrackSelection:`export const useTrackSelection=()=>({selecting:false,exit(){},enter(){},ids:new Set()});export const BatchTrackActions=()=>null`,
 ActionMenu:`import {createElement} from 'react';export const ActionMenu=({children})=>createElement('aside',null,children(()=>{}))`,
 platform:`export const isMobile=false,isIOS=false,isAndroid=false,isOHOS=false,isLargeScreen=false`,
 core:`export const isTauri=()=>false;export const invoke=async()=>null`,
}
b.onResolve({filter:/@tauri-apps\/api\/core$/},()=>({path:'core',namespace:'fixture'}))
b.onResolve({filter:/\/(playerStore|playlistImport|importedEntries|useCompactLayout|useLocateCurrentRow|sourceTitles|sync|TrackMenuButton|DownloadsView|ListSort|useTrackSelection|ActionMenu|platform)$/},a=>({path:a.path.split('/').at(-1),namespace:'fixture'}))
b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'js'}))
}}]})
const m={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,m,m.exports)
const {LibraryView,PlaylistMenu,ReplacementSearch,ImportedPlaylistCompletionContent,accountQueryKey,formatMatchPlayCount}=m.exports
const playlist={id:'import:test',name:'导入歌曲',description:'',isSystem:false,trackCount:2}
const track=Object.freeze({id:'bilibili:BV1GJ411x7h7:1',source:Object.freeze({provider:'bilibili',bvid:'BV1GJ411x7h7',cid:1,page:1}),title:'VIDEO_RAW_TITLE',artist:'VIDEO_RAW_ARTIST',coverUrl:'https://example.test/raw.jpg',durationSeconds:277,liked:false})
const ordinary=Object.freeze({...track,id:'bilibili:BV1GJ411x7h8:2',source:{...track.source,bvid:'BV1GJ411x7h8',cid:2},title:'MANUALLY_ADDED_VIDEO'})
const saved={entryId:'row1',playlistId:playlist.id,order:0,song:{sourceId:'qq:1',title:'SOURCE_SONG',artists:['SOURCE_ARTIST'],coverUrl:'https://example.test/original.jpg'},trackId:track.id,revision:'1',mode:'automatic'}
const missing={entryId:'row2',playlistId:playlist.id,order:8,song:{sourceId:'qq:2',title:'MISSING_SONG',artists:['SOURCE_ARTIST']},revision:'1',message:'该视频已在歌单中，请选择其他视频'}
function render(Component,props={},entries=[saved,missing],tracks=[track,ordinary]){
 const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}})
 client.setQueryData(accountQueryKey('library','saved',playlist.id),tracks)
 client.setQueryData(accountQueryKey('imported-entries',playlist.id),{session:'test',entries})
 return renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(Component,props)))
}
test('only external provenance entries expose replacement, not ordinary songs sharing the import playlist',()=>{
 const html=render(LibraryView,{playlist,onRematchImported(){}})
 assert.equal((html.match(/data-can-replace="true"/g)||[]).length,1)
 assert.equal((html.match(/data-can-replace="false"/g)||[]).length,1)
 assert.ok(html.includes('SOURCE_SONG'));assert.ok(html.includes('SOURCE_ARTIST'));assert.ok(html.includes('https://example.test/original.jpg'))
 assert.ok(html.includes('MANUALLY_ADDED_VIDEO'))
 assert.equal(track.title,'VIDEO_RAW_TITLE');assert.equal(track.artist,'VIDEO_RAW_ARTIST');assert.equal(track.coverUrl,'https://example.test/raw.jpg')
})
test('Bilibili copies have no replacement or completion entry merely because their ID has an import prefix',()=>{
 const html=render(LibraryView,{playlist,onRematchImported(){}},[])
 assert.equal(html.includes('data-can-replace="true"'),false)
 assert.equal(html.includes('补全未匹配'),false)
})
test('completion entry remains usable even if no matched song exists yet',()=>{
 const html=render(PlaylistMenu,{playlist:{...playlist,trackCount:0},onRematch(){},missingCount:822})
 assert.ok(html.includes('补全未匹配'))
 const button=html.match(/<button[^>]*>[^]*?补全未匹配[^]*?<\/button>/g)?.at(-1)
 assert.ok(button);assert.equal(/disabled/.test(button.slice(button.lastIndexOf('<button'),button.indexOf('补全未匹配'))),false)
})
test('completion displays only empty bindings with original order and explicit retry/find controls',()=>{
 globalThis.importUiJob=null
 const html=render(ImportedPlaylistCompletionContent,{playlist,onClose(){}})
 assert.ok(html.includes('MISSING_SONG'));assert.equal(html.includes('SOURCE_SONG'),false)
 assert.ok(html.includes('import-completion-position">9<'))
 assert.ok(html.includes('全部重试'));assert.ok(html.includes('aria-label="重新匹配 MISSING_SONG"'));assert.ok(html.includes('查找'))
 assert.match(html,/aria-label="移除 MISSING_SONG"/)
 assert.doesNotMatch(html,/aria-label="移除 SOURCE_SONG"/)
 assert.ok(html.includes(missing.message))
})
test('active completion can be paused and does not start another per-row automatic match',()=>{
 globalThis.importUiJob={playlistId:playlist.id,state:'matching',message:'正在匹配 MISSING_SONG'}
 const html=render(ImportedPlaylistCompletionContent,{playlist,onClose(){}})
 assert.ok(html.includes('暂停'));assert.equal(html.includes('全部重试'),false)
 assert.match(html,/disabled="" aria-label="重新匹配 MISSING_SONG"/)
 assert.match(html,/disabled="" aria-label="移除 MISSING_SONG"/)
 globalThis.importUiJob=null
})
test('replacement keeps source context separate from the actual current video and offers unrestricted text/BV search',()=>{
 const html=render(ReplacementSearch,{entry:saved,session:'test',currentTrack:track,onSaved(){},onClose(){}})
 assert.ok(html.includes('SOURCE_SONG'));assert.ok(html.includes('当前视频：VIDEO_RAW_TITLE'))
 assert.ok(html.includes('搜索视频，或粘贴 BV / 链接'));assert.ok(html.includes('aria-label="搜索替换视频"'))
 assert.ok(html.includes('value="SOURCE_SONG SOURCE_ARTIST"'))
 assert.equal(track.title,'VIDEO_RAW_TITLE')
 assert.equal(formatMatchPlayCount(1278901),'127.9万');assert.equal(formatMatchPlayCount(120000000),'1.2亿');assert.equal(formatMatchPlayCount(0),'0')
})

test('explicit metadata edits remain visible instead of being hidden by import source labels',()=>{
 const edited={...track,titleOverridden:true,title:'MY_EDITED_TITLE',displayTitle:'MY_EDITED_TITLE',artist:'MY_EDITED_ARTIST'}
 const html=render(LibraryView,{playlist},[saved],[edited])
 assert.ok(html.includes('MY_EDITED_TITLE'));assert.ok(html.includes('MY_EDITED_ARTIST'))
 assert.equal(html.includes('SOURCE_SONG'),false);assert.equal(html.includes('https://example.test/original.jpg'),false)
 assert.ok(html.includes('https://example.test/raw.jpg'))
})
