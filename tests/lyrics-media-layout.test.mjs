import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
const {QueryClient,QueryClientProvider}=createRequire(import.meta.url)('@tanstack/react-query')

const mocks={
 platform:`export const isMobile=globalThis.mediaLayout.mobile,isIOS=false,isOHOS=false,isAndroid=isMobile,isLargeScreen=false;`,
 useCompactLayout:`export const useCompactLayout=()=>globalThis.mediaLayout.compact;`,
 playerStore:`export const usePlayerStore=selector=>selector(globalThis.mediaLayout.state);export const playbackClock=()=>0,playbackRates=[1],reloadCurrentAudioSource=()=>{};`,
 floatingLyrics:`export const useFloatingLyrics=selector=>selector({error:''});`,
 useBiliSubtitles:`export const useBiliSubtitles=()=>({choices:[],toggle(){},active:false,preferred:false});`,
 useAutoLyricAlignment:`export const useAutoLyricAlignment=()=>({busy:false,message:'',failed:false});`,
 useSourceTitleMetadata:`export const useSourceTitleMetadata=()=>null;`,
 useArtworkFit:`export const useArtworkFit=()=>({stage:{current:null},onRatio(){}});`,
 mobileAudio:`export const controlMobileAudio=async()=>{};`,
 trackActionStore:`export const chooseTrackPlaylist=()=>{};`,
 desktopApi:`${['getDanmaku','getVideoSource','getStoredLyrics','enrichStoredLyricLines','getVideoParts','saveStoredLyrics','searchLyrics','setStoredLyricsBias'].map(n=>`export const ${n}=async()=>null;`).join('')}export const commandErrorMessage=String;`,
}
for(const [module,names] of Object.entries({SeekRange:['SeekRange'],FloatingLyricsToggle:['FloatingLyricsToggle'],SeasonBrowser:['SeasonBrowser'],MobilePlaybackRate:['MobilePlaybackRate','PlaybackRateEntry'],PlaybackSettings:['PlaybackSettings'],SleepTimer:['SleepTimerEntry'],MetadataDialog:['MetadataDialog'],PlayingVideoReplacement:['PlayingVideoReplacement'],TouchOptions:['TouchOptions'],MobilePartsPage:['MobilePartsPage'],CommentsPanel:['CommentsPanel'],LyricsChooser:['LyricsChooser'],DanmakuCanvas:['DanmakuCanvas'],SyncedVideo:['SyncedVideo'],LyricsBiasControl:['LyricsBiasControl']}))mocks[module]=names.map(n=>`export const ${n}=()=>null;`).join('')

async function renderer(mobile){
 globalThis.mediaLayout={mobile,compact:false,mode:'cover'}
 globalThis.window=Object.assign(new EventTarget(),{setTimeout,clearTimeout,setInterval,clearInterval})
 const bundle=await build({entryPoints:['src/features/lyrics/LyricsView.tsx'],bundle:true,write:false,platform:'node',format:'cjs',external:['react','react/jsx-runtime','@tanstack/react-query'],plugins:[{name:'media-layout-boundaries',setup(b){
  b.onResolve({filter:/.*/},args=>{const name=args.path.split('/').at(-1);if(Object.hasOwn(mocks,name))return{path:name,namespace:'fixture'}})
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:mocks[args.path],loader:'js'}))
 }}]})
 const m={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
 return (compact,mode)=>{
  globalThis.mediaLayout.compact=compact
  globalThis.document={getElementById:()=>null}
  globalThis.localStorage={getItem:key=>key==='lyrics-media-mode'?mode:null}
  globalThis.mediaLayout.state={current:{id:'bilibili:BV1GJ411x7h7:1',source:{provider:'bilibili',bvid:'BV1GJ411x7h7',cid:1,page:1,aid:1},title:'测试歌曲',durationSeconds:240},status:'paused',durationSeconds:240,progressSeconds:0}
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  try{return renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(m.exports.LyricsView,{onOpenSleepTimer(){},onClose(){},onFavorite(){},favoritePending:false,onOpenCollection(){}})))}finally{client.clear()}
 }
}

// Inspect rendered parents, rather than checking a particular JSX spelling.
function nodes(html){
 const root={tag:'root',attrs:'',children:[]},stack=[root],all=[]
 for(const match of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/gi)){
  const [,close,tag,attrs]=match
  if(close){if(stack.at(-1).tag===tag)stack.pop();continue}
  const node={tag,attrs,parent:stack.at(-1),children:[]};node.parent.children.push(node);all.push(node)
  if(!/^(?:input|img|br|hr|meta|link|source|area|wbr)$/i.test(tag)&&!attrs.endsWith('/'))stack.push(node)
 }
 return all
}
const hasClass=(node,name)=>new RegExp(`class="[^"]*\\b${name}\\b`).test(node.attrs)
const mobileRender=await renderer(true)
test('tablet video controls stay inside the video frame; cover mode has one toggle outside it',()=>{
 const video=nodes(mobileRender(false,'video')),tools=video.find(n=>hasClass(n,'video-tools'))
 assert.ok(hasClass(tools.parent,'lyrics-cover'));assert.ok(hasClass(tools.parent,'video-active'))
 assert.equal(tools.children.filter(n=>n.tag==='button').length,4)
 assert.equal(video.some(n=>hasClass(n,'lyrics-meta-actions')),false,'phone action row must not leak into tablet layout')
 const cover=nodes(mobileRender(false,'cover')),coverTools=cover.find(n=>hasClass(n,'video-tools'))
 assert.ok(hasClass(coverTools.parent,'lyrics-media'));assert.equal(coverTools.children.filter(n=>n.tag==='button').length,1)
})
test('phone keeps its existing media-stage controls and compact song action row in both modes',()=>{
 for(const mode of ['cover','video']){
  const html=nodes(mobileRender(true,mode)),tools=html.find(n=>hasClass(n,'video-tools'))
  assert.ok(hasClass(tools.parent,'lyrics-media'));assert.equal(html.filter(n=>hasClass(n,'lyrics-meta-actions')).length,1)
 }
})
test('desktop keeps its existing media-stage toolbar without the phone-only action row',async()=>{
 const render=await renderer(false),html=nodes(render(false,'video')),tools=html.find(n=>hasClass(n,'video-tools'))
 assert.ok(hasClass(tools.parent,'lyrics-media'));assert.equal(html.some(n=>hasClass(n,'lyrics-meta-actions')),false)
})
