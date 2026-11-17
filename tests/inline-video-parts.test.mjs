import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {build} from 'esbuild'
const {QueryClient,QueryClientProvider}=createRequire(import.meta.url)('@tanstack/react-query')
const output=await build({stdin:{contents:`export {VideoPartsList} from './src/features/library/VideoPartsList';export {accountQueryKey} from './src/services/queryKeys';export {useContentVisibility} from './src/services/contentVisibility'`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime','@tanstack/react-query'],plugins:[{name:'list-boundaries',setup(b){
 const modules={visibility:`export const useVisibilityRules=()=>globalThis.inlineVisibilityRules||[];export const saveVisibility=async()=>{};export const useContentVisibility={setState:({rules})=>globalThis.inlineVisibilityRules=rules}`,playerStore:`export const usePlayerStore=selector=>selector({});usePlayerStore.getState=()=>({playFromList(){}})`,useLocateCurrentRow:'export function useLocateCurrentRow(){}',useVisibleVideoPages:'export const useVisibleVideoPages=()=>({ref:{current:null},pages:[]})',TrackMenuButton:'export const TrackMenuButton=()=>null',useTrackSelection:'export const useTrackSelection=()=>({selecting:globalThis.inlinePartsSelecting,ids:new Set(),enter(){},toggle(){}});export const BatchTrackActions=()=>null',platform:'export const isMobile=false'}
 b.onResolve({filter:/\/(playerStore|useLocateCurrentRow|useVisibleVideoPages|TrackMenuButton|useTrackSelection|platform)$/},args=>({path:args.path.split('/').at(-1),namespace:'fixture'}))
 b.onResolve({filter:/services\/contentVisibility$/},()=>({path:'visibility',namespace:'fixture'}))
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path],loader:'js'}))
}}]})
const module={exports:{}}
new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
const {VideoPartsList,accountQueryKey,useContentVisibility}=module.exports
const row=(bvid)=>({id:bvid,title:`VIDEO_${bvid}`,durationSeconds:60,partCount:2,source:{provider:'bilibili',bvid,page:1,cid:1}})
const tracks=['A','B','C'].map(row)
function render(props={}){
 globalThis.inlinePartsSelecting=Boolean(props.selecting)
 const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity}}})
 client.setQueryData(accountQueryKey('collections'),{folders:[],items:props.saved||[]})
 return renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(VideoPartsList,{tracks,videoCollection:true,renderDetails:track=>createElement('aside',{'data-detail-for':track.source.bvid},`DETAIL_${track.source.bvid}`),...props})))
}
test('expanded parts render immediately after their own video, before the next result',()=>{
 const html=render()
 for(const [id,next] of [['A','B'],['B','C']]){
  assert.ok(html.indexOf(`aria-label="播放 VIDEO_${id}"`)<html.indexOf(`DETAIL_${id}`))
  assert.ok(html.indexOf(`DETAIL_${id}`)<html.indexOf(`aria-label="播放 VIDEO_${next}"`))
 }
 assert.ok(html.indexOf('DETAIL_C')>html.indexOf('aria-label="播放 VIDEO_C"'))
})
test('filtered or paginated results expand by stable video identity rather than previous row index',()=>{
 const html=render({visibleTracks:[tracks[2],tracks[0]]})
 assert.equal(html.includes('DETAIL_B'),false)
 assert.ok(html.indexOf('DETAIL_C')<html.indexOf('aria-label="播放 VIDEO_A"'))
 assert.ok(html.indexOf('aria-label="播放 VIDEO_A"')<html.indexOf('DETAIL_A'))
 assert.deepEqual(tracks.map(t=>t.id),['A','B','C'])
})
test('only the chosen row gets details, and batch selection temporarily hides nested lists',()=>{
 const html=render({renderDetails:track=>track.id==='B'?createElement('aside',null,'CHOSEN_PARTS'):null})
 assert.equal((html.match(/CHOSEN_PARTS/g)||[]).length,1)
 assert.ok(html.indexOf('VIDEO_B')<html.indexOf('CHOSEN_PARTS')&&html.indexOf('CHOSEN_PARTS')<html.indexOf('VIDEO_C'))
 assert.equal(render({selecting:true}).includes('DETAIL_'),false)
 assert.equal(render({visibleTracks:[]}), '')
})
test('unmanaged search parts stay complete, bookmarked and followed content exposes management',()=>{
 const parts=[1,2].map(cid=>({...row('A'),id:`A:${cid}`,source:{...row('A').source,cid,page:cid,uploaderId:7}}))
 useContentVisibility.setState({rules:[{scope:'video:A',target:'cid:1',hidden:true}]})
 const props={videoCollection:false,tracks:parts}
 const ordinary=render(props)
 assert.equal(ordinary.includes('管理隐藏'),false)
 assert.equal((ordinary.match(/class="video-part-play"/g)||[]).length,2)
 for(const saved of [[{bvid:'A'}],[{bvid:'up:7'}]]){
  const html=render({...props,saved})
  assert.equal(html.includes('管理隐藏'),true)
  assert.equal((html.match(/class="video-part-play"/g)||[]).length,1)
 }
 assert.equal(render({...props,saved:[{bvid:'up:8'}]}).includes('管理隐藏'),false)
 assert.equal(render({...props,savedContainer:true}).includes('管理隐藏'),true)
 useContentVisibility.setState({rules:[]})
})
test('collection toolbar combines playback and list actions without repeating the item count',()=>{
 const html=render({queueSource:{kind:'season',title:'collection',collectionRef:'season:7:9'},saved:[{bvid:'season:7:9'}],toolbar:{primary:createElement('button',null,'PLAY_ALL'),actions:createElement('button',null,'SORT_LIST')},listHeader:createElement('aside',null,'SEASON_CATEGORIES')})
 assert.equal((html.match(/collection-unified-toolbar/g)||[]).length,1)
 assert.equal(html.includes('video-parts-toolbar'),false)
 assert.equal((html.match(/管理隐藏/g)||[]).length>0,true)
 assert.ok(html.indexOf('PLAY_ALL')<html.indexOf('管理隐藏'))
 assert.ok(html.indexOf('多选')<html.indexOf('SORT_LIST'))
 assert.ok(html.indexOf('SORT_LIST')<html.indexOf('SEASON_CATEGORIES'))
 assert.ok(html.indexOf('SEASON_CATEGORIES')<html.indexOf('aria-label="播放 VIDEO_A"'))
})
test('collection loading or empty results keep a single toolbar and status content',()=>{
 const html=render({tracks:[],toolbar:{primary:createElement('button',{disabled:true},'PLAY_ALL'),actions:null},listHeader:createElement('p',null,'LOADING_OR_EMPTY')})
 assert.equal((html.match(/collection-unified-toolbar/g)||[]).length,1)
 assert.ok(html.includes('LOADING_OR_EMPTY'))
 assert.match(html,/aria-label="多选"[^>]*disabled/)
 assert.equal(html.includes('video-parts-toolbar'),false)
})
test('an empty text filter does not incorrectly say every result was hidden',()=>{
 const html=render({visibleTracks:[],queueSource:{kind:'season',title:'collection',collectionRef:'season:7:9'},saved:[{bvid:'season:7:9'}],toolbar:{primary:null,actions:null}})
 assert.ok(html.includes('没有匹配的内容'))
 assert.equal(html.includes('内容已隐藏'),false)
})
