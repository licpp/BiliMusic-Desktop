import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { editionManifest } from '../scripts/android-manifest.mjs'
const code = (await build({entryPoints:['src/large-screen/focus.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
const {nextFocus}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const box=(id,left,top,width=60,height=60)=>({id,left,top,width,height})
test('D-pad prioritizes the same row and never activates another control',()=>{
 const current=box('a',0,0)
 assert.equal(nextFocus(current,[box('diagonal',65,70),box('row',150,0)],'ArrowRight'),'row')
 assert.equal(nextFocus(current,[box('below',0,100),box('far',90,65)],'ArrowDown'),'below')
 assert.equal(nextFocus(current,[box('hidden',80,0,0,0)],'ArrowRight'),undefined)
 assert.equal(nextFocus(current,[box('behind',-70,0)],'ArrowRight'),undefined)
})
test('all directions, edges and equal-distance ties are deterministic',()=>{
 const c=box('center',100,100),items=[c,box('up',100,0),box('down',100,200),box('left',0,100),box('right',200,100)]
 for(const [key,id] of [['ArrowUp','up'],['ArrowDown','down'],['ArrowLeft','left'],['ArrowRight','right']])assert.equal(nextFocus(c,items,key),id)
 assert.equal(nextFocus(c,[],'ArrowUp'),undefined)
 assert.equal(nextFocus(c,[box('z',200,100),box('a',200,100)],'ArrowRight'),'a')
})
const manifest=`<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-feature android:name="android.software.leanback" android:required="false"/><application><activity android:name=".MainActivity"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/><category android:name="android.intent.category.LEANBACK_LAUNCHER"/></intent-filter></activity></application></manifest>`
test('phone stays off TV launchers and the large APK has an independent manifest',()=>{
 const phone=editionManifest(manifest),large=editionManifest(manifest,true)
 assert.doesNotMatch(phone,/LEANBACK_LAUNCHER|software.leanback|screenOrientation/)
 assert.match(large,/touchscreen" android:required="false"/)
 assert.match(large,/LEANBACK_LAUNCHER/)
 assert.match(large,/sensorLandscape/)
 assert.match(large,/SYSTEM_ALERT_WINDOW" tools:node="remove"/)
 assert.match(large,/android:banner="@drawable\/tv_banner"/)
})
test('car launchers keep the existing component and the WebView activity stays private', () => {
 const large = editionManifest(manifest, true)
 const launcher = large.match(/<activity\b[^>]*android:name="\.MainActivity"[^>]*>([\s\S]*?)<\/activity>/)?.[1]
 assert.match(launcher, /android\.intent\.category\.LAUNCHER/)
 assert.match(launcher, /android\.intent\.category\.LEANBACK_LAUNCHER/)
 assert.match(large, /<activity\b[^>]*android:screenOrientation="sensorLandscape"[^>]*android:name="\.CarPlayerActivity"[^>]*android:exported="false"[^>]*\/>/)
 assert.doesNotMatch(editionManifest(manifest), /CarPlayerActivity/)
})
test('large screen target preserves native Android identity and uses isolated outputs',async()=>{
 const config=JSON.parse(await readFile('src-tauri/tauri.large-screen.conf.json','utf8'))
 const phone=JSON.parse(await readFile('src-tauri/tauri.android.conf.json','utf8'))
 assert.notEqual(config.identifier,phone.identifier)
 assert.equal(config.build.frontendDist,'../dist-large-screen')
 assert.match(await readFile('scripts/android-large-screen.mjs','utf8'),/artifacts\/build\/large-screen\/source/)
 const entry=await readFile('src/large-screen/main.tsx','utf8')
 assert.doesNotMatch(entry,/installMobileGestures/)
 assert.match(entry,/installMainWindowRuntime\(client\)/)
 assert.match(await readFile('src/main.tsx','utf8'),/floating \|\| tray \? installAccountQueryScope\(queryClient\) : installMainWindowRuntime\(queryClient\)/)
})
test('manifest preparation is repeatable after regenerating or preparing twice',()=>{
 const once=editionManifest(manifest,true)
 assert.equal(editionManifest(once,true),once)
})
test('ordinary playlists and single search videos keep the shared resume threshold',async()=>{
 const src=(await build({entryPoints:['src/large-screen/playbackContext.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
 const {playlistContext,collectionContext}=await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)
 const policy=(await build({entryPoints:['src/features/player/resumePolicy.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
 const {isCollectionPlayback}=await import(`data:text/javascript;base64,${Buffer.from(policy).toString('base64')}`)
 const track={id:'one',source:{bvid:'BV1',page:1},partCount:1}
 assert.equal(isCollectionPlayback(track,[track],playlistContext('歌单',false)),false)
 assert.equal(isCollectionPlayback(track,[track],collectionContext('搜索','BV1',false,1)),false)
 assert.equal(isCollectionPlayback(track,[track],collectionContext('合集','season:1:2',true,1)),true)
 assert.equal(isCollectionPlayback(track,[track],collectionContext('多P','BV1',false,3)),true)
})
test('down enters the immediately following settings row instead of a closer footer',async()=>{
 const {nextRowFocus}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
 const current=box('cache',100,100)
 assert.equal(nextRowFocus(current,[box('theme',850,180),box('footer',100,400)],'ArrowDown'),'theme')
 assert.equal(nextRowFocus(box('theme',850,180),[current,box('footer',850,400)],'ArrowUp'),'cache')
})
test('a search input is the vertical entry point of its row, not its submit button',async()=>{
 const {nextRowFocus}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
 const above=box('above',900,0),input={...box('input',200,100,600,54),primary:true},submit=box('submit',900,100)
 assert.equal(nextRowFocus(above,[input,submit,box('results',900,200)],'ArrowDown'),'input')
 assert.equal(nextRowFocus(box('results',900,200),[input,submit],'ArrowUp'),'input')
})

const navigationCode=(await build({entryPoints:['src/large-screen/navigation.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
const {matchBookmark,restoreView}=await import(`data:text/javascript;base64,${Buffer.from(navigationCode).toString('base64')}`)
const bookmark={key:'track-b',label:'原来的歌曲',tag:'BUTTON',region:'.large-main',index:2,occurrence:0}
test('back focus uses stable identity despite renamed/reordered rows and handles duplicate labels',()=>{
 assert.equal(matchBookmark(bookmark,[{key:'track-b',label:'新标题',tag:'BUTTON'}]),0)
 assert.equal(matchBookmark({...bookmark,key:undefined,label:'更多',occurrence:1},[{label:'更多',tag:'BUTTON'},{label:'更多',tag:'BUTTON'}]),1)
 assert.equal(matchBookmark(bookmark,[{label:'其他',tag:'BUTTON'}]),-1)
 assert.equal(matchBookmark(bookmark,[{label:'其他',tag:'BUTTON'}],true),0)
 assert.equal(matchBookmark(bookmark,[],true),-1)
})
function restorationFixture(run, savedBookmark = bookmark) {
 const saved=Object.fromEntries(['MutationObserver','ResizeObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','setInterval','clearInterval','setTimeout','clearTimeout','queueMicrotask'].map(k=>[k,globalThis[k]]))
 let mutate,interval,first,focused;let rows=[],busy=true
 globalThis.MutationObserver=class{constructor(fn){mutate=fn}observe(){}disconnect(){}}
 globalThis.ResizeObserver=class{observe(){}disconnect(){}}
 globalThis.getComputedStyle=()=>({visibility:'visible'})
 globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}
 globalThis.setInterval=fn=>{interval=fn;return 1};globalThis.clearInterval=()=>{}
 globalThis.setTimeout=()=>1;globalThis.clearTimeout=()=>{}
 globalThis.queueMicrotask=fn=>{first=fn}
 const main=Object.assign(new EventTarget(),{children:[],scrollTop:0,querySelectorAll:()=>rows})
 const group={open:false,dataset:{focus:"playback-cache"}}
 const root=Object.assign(new EventTarget(),{querySelector:()=>main,querySelectorAll:()=>[group]})
 const row=key=>({dataset:{focus:key},textContent:key,tagName:'BUTTON',tabIndex:0,getAttribute:()=>null,closest:()=>null,getClientRects:()=>[{}],focus:()=>{focused=key}})
 const cancel=restoreView(root,main,savedBookmark,640,()=>busy)
 try {run({root,main,group,row,setRows:value=>{rows=value},mutate:()=>mutate(),tick:()=>interval(),first:()=>first(),idle:()=>{busy=false},focused:()=>focused})}
 finally{cancel();Object.assign(globalThis,saved)}
}
test('back waits for async rows, restores scroll and does not steal focus after new input',()=>{
 restorationFixture(h=>{
   h.setRows([h.row('back')]);h.first();h.tick();h.tick();assert.equal(h.focused(),undefined)
   h.setRows([h.row('back'),h.row('track-b')]);h.mutate();assert.equal(h.focused(),'track-b');assert.equal(h.main.scrollTop,640)
 })
 restorationFixture(h=>{
   h.root.dispatchEvent(new Event('keydown'));h.setRows([h.row('track-b')]);h.mutate();h.tick();assert.equal(h.focused(),undefined)
 })
})
test('deleted return target falls back to its nearest surviving position after loading',()=>{
 restorationFixture(h=>{h.setRows([h.row('first'),h.row('nearby')]);h.first();h.idle();h.tick();assert.equal(h.focused(),undefined);h.tick();assert.equal(h.focused(),'nearby')})
})

test('return reopens the saved settings group before looking for its control',()=>{
 restorationFixture(h=>{h.first();assert.equal(h.group.open,true);h.setRows([h.row('track-b')]);h.mutate();assert.equal(h.focused(),'track-b')},{...bookmark,openGroups:['playback-cache']})
})

test('cross-region focus enters the nearest menu row rather than its active page',async()=>{
 const {nearestRegionFocus}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
 const rail=[box('home',10,20),box('library',10,90),box('search',10,160),box('settings',10,430)]
 assert.equal(nearestRegionFocus(box('bottom-content',200,420),rail),'settings')
 assert.equal(nearestRegionFocus(box('search-row',200,150),rail),'search')
 assert.equal(nearestRegionFocus(box('any',0,0),[]),undefined)
})

const layoutCode=(await build({entryPoints:['src/large-screen/playerLayout.ts'],bundle:true,write:false,format:'esm'})).outputFiles[0].text
const {fitMediaFrame,centeredLyricScroll,playerViewportLayout,lyricRowCount}=await import(`data:text/javascript;base64,${Buffer.from(layoutCode).toString('base64')}`)
test('the safe width and height select the expanded media layout only when the controls fit in one row',()=>{
 assert.deepEqual(playerViewportLayout(1280,800),{density:'regular',wideMedia:false})
 assert.deepEqual(playerViewportLayout(1280,720),{density:'regular',wideMedia:false})
 assert.deepEqual(playerViewportLayout(1920,720),{density:'regular',wideMedia:false})
 assert.deepEqual(playerViewportLayout(1864,612),{density:'compact',wideMedia:true})
 assert.deepEqual(playerViewportLayout(1280,480),{density:'compact',wideMedia:true})
 assert.deepEqual(playerViewportLayout(1224,372),{density:'compact',wideMedia:true})
 assert.deepEqual(playerViewportLayout(968,312),{density:'tight',wideMedia:true})
 assert.deepEqual(playerViewportLayout(814,256),{density:'tight',wideMedia:true})
 assert.deepEqual(playerViewportLayout(740,430),{density:'compact',wideMedia:true})
 assert.deepEqual(playerViewportLayout(720,372),{density:'compact',wideMedia:true})
 assert.deepEqual(playerViewportLayout(719,372),{density:'compact',wideMedia:false})
})
test('short lyric windows prioritize the current line and budget room for translations',()=>{
 assert.equal(lyricRowCount(140,false),1)
 assert.equal(lyricRowCount(185,false),3)
 assert.equal(lyricRowCount(185,true),1)
 assert.equal(lyricRowCount(275,true),3)
 assert.equal(lyricRowCount(400,true),5)
 assert.equal(lyricRowCount(600,false),7)
})
test('old car WebViews can place the lyric viewport and pad the first and final lines', async () => {
 const css = await readFile('src/large-screen/large-screen.css', 'utf8')
 const legacyRules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/[^{}]*:is\([^{}]*\{[^{}]*\}/g, '')
 const flattenedRegions = [...legacyRules.matchAll(/([^{}]+)\{\s*display:contents\s*;?\s*\}/g)]
   .flatMap(match => match[1].split(',').map(selector => selector.trim()))
 for (const region of ['body', 'info', 'footer']) {
   assert.ok(flattenedRegions.includes(`.large-player[data-wide-media] .large-player-${region}`))
 }
 assert.match(legacyRules, /html\[data-layout="large"\] #root\s*\{\s*min-width:0;/)
 assert.match(legacyRules, /\.large-lyric-window\s*\{[^{}]*padding-top:var\(--large-lyric-inset,[^{}]*padding-bottom:var\(--large-lyric-inset,/)
})
test('car settings and the dock keep their layout without modern selectors or flex gaps', async () => {
 const css = await readFile('src/large-screen/large-screen.css', 'utf8')
 const legacyRules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/[^{}]*:(?:is|has)\([^{}]*\{[^{}]*\}/g, '')
 assert.match(legacyRules, /\.large-settings-common>section\.settings-card\s*\{[^{}]*display:grid;[^{}]*grid-template-columns:28px minmax\(0,1fr\) auto;[^{}]*grid-gap:/)
 assert.match(legacyRules, /\.large-settings-common summary>\.settings-icon\s*\{\s*margin-right:/)
 assert.match(legacyRules, /\.large-playback-settings \.touch-option-trigger\s*\{[^{}]*grid-template-columns:/)
 assert.match(legacyRules, /\.large-dock-song>\.artwork\s*\{[^{}]*margin-right:var\(--dock-art-spacing\)/)
 assert.match(legacyRules, /\.large-dock-actions button>svg\s*\{\s*margin-right:/)
 assert.match(legacyRules, /\.large-dock-song>span:last-child\s*\{[^{}]*flex:1;min-width:0;/)
 assert.match(legacyRules, /\.large-nav-items\s*\{[^{}]*flex:1 0 auto;/)
})
test('the standard car player bounds the shared row when timed lyrics resize', async () => {
 const css = await readFile('src/large-screen/large-screen.css', 'utf8')
 // Chromium 74 grew an implicit auto row on each lyric viewport measurement.
 for (const selector of ['large-player-body', 'large-lyrics']) {
   const declarations = css.match(new RegExp(`^\\.${selector}\\s*\\{([^{}]*)\\}`, 'm'))?.[1] ?? ''
   assert.match(declarations, /(?:^|;)\s*grid-template-rows:\s*minmax\(0(?:px)?,\s*1fr\)\s*(?:;|$)/, `.${selector} requires a bounded grid row`)
 }
})
test('video frames retain their ratio inside the reserved stage on wide, narrow and portrait sources',()=>{
 for(const [width,height,ratio] of [[480,204,16/9],[200,360,16/9],[480,300,9/16],[800,300,4/3]]){
  const fit=fitMediaFrame(width,height,ratio)
  assert.ok(fit.width<=width+.001 && fit.height<=height+.001)
  assert.ok(Math.abs(fit.width/fit.height-ratio)<.0001)
 }
 assert.deepEqual(fitMediaFrame(0,200,16/9),{width:0,height:0})
 assert.deepEqual(fitMediaFrame(320,180,NaN),{width:320,height:180})
})
test('native lyric scrolling centers first, last and wrapped lines within bounds',()=>{
 assert.equal(centeredLyricScroll(200,100,500,2000),0)
 assert.equal(centeredLyricScroll(600,100,500,2000),400)
 assert.equal(centeredLyricScroll(1600,100,500,2000),1400)
 assert.equal(centeredLyricScroll(1900,100,500,2000),1500)
 assert.equal(centeredLyricScroll(600,180,500,2000),440)
 assert.equal(centeredLyricScroll(0,100,500,100),0)
})

test('overlapping track menu and download dialog release background locks in either order',async()=>{
 const result=await build({entryPoints:['src/large-screen/dialogInert.ts'],bundle:true,write:false,format:'esm'})
 const {lockDialogBackground}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
 for(const order of [[0,1],[1,0]]){
  const root={inert:false},release=[lockDialogBackground(root),lockDialogBackground(root)]
  assert.equal(root.inert,true)
  release[order[0]]();assert.equal(root.inert,true)
  release[order[0]]();assert.equal(root.inert,true)
  release[order[1]]();assert.equal(root.inert,false)
 }
 const root={inert:true},release=lockDialogBackground(root);release();assert.equal(root.inert,true)
})

test('footer left/right follows toolbar order even when clipped lyric rectangles overlap it',async()=>{
 const {installDirectionalFocus}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
 const original={document:globalThis.document,window:globalThis.window,getComputedStyle:globalThis.getComputedStyle}
 let focused,handlers=new Map()
 const footer={matches:selector=>selector==='.large-player-footer',contains:el=>el.region===footer}
 const lyrics={matches:()=>false,contains:el=>el.region===lyrics}
 const element=(id,region,x)=>({id,region,tabIndex:0,dataset:{},matches:()=>false,
  getAttribute:()=>null,closest:selector=>selector.includes('.large-player-footer')?region:null,
  getClientRects:()=>[{}],getBoundingClientRect:()=>({left:x,top:500,width:40,height:44}),focus:()=>{focused=id}})
 const clipped=element('clipped-lyric',lyrics,680)
 const controls=[element('supplement',footer,640),element('match',footer,730),element('bias',footer,870)]
 const shell={querySelectorAll:()=>[clipped,...controls]},main={contains:()=>true}
 globalThis.document={querySelectorAll:()=>[],querySelector:selector=>selector==='.large-shell'?shell:selector==='.large-main'?main:null,addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener(){}}
 globalThis.window={addEventListener(){},removeEventListener(){}}
 globalThis.getComputedStyle=()=>({visibility:'visible'})
 const cleanup=installDirectionalFocus()
 try{
  const press=(index,key)=>{focused=controls[index].id;handlers.get('keydown')({key,target:controls[index],preventDefault(){},defaultPrevented:false});return focused}
  for(const x of [660,680,710,820]){
   clipped.getBoundingClientRect=()=>({left:x,top:500,width:40,height:44})
   assert.equal(press(0,'ArrowRight'),'match')
   assert.equal(press(1,'ArrowRight'),'bias')
   assert.equal(press(2,'ArrowLeft'),'match')
   assert.equal(press(1,'ArrowLeft'),'supplement')
   assert.equal(press(2,'ArrowRight'),'bias')
   assert.equal(press(0,'ArrowLeft'),'supplement')
  }
  // A missing/disabled option is not in focusable elements, and cannot trap navigation.
  shell.querySelectorAll=()=>[clipped,controls[1],controls[2]]
  assert.equal(press(1,'ArrowRight'),'bias')
  assert.equal(press(1,'ArrowLeft'),'match')
 }finally{cleanup();Object.assign(globalThis,original)}
})

test('player header stays in toolbar order and the video window has an exit to back', async () => {
 const {installDirectionalFocus}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
 const original={document:globalThis.document,window:globalThis.window,getComputedStyle:globalThis.getComputedStyle}
 let focused;const handlers=new Map()
 const header={matches:s=>s==='.large-player-header',contains:el=>el.region===header}
 const info={matches:()=>false,contains:el=>el.region===info}
 const lyrics={matches:()=>false,contains:el=>el.region===lyrics}
 const el=(id,region,left,top,width=60,height=48,links={})=>({id,region,tabIndex:0,dataset:{focus:id},matches:()=>false,
  getAttribute:name=>links[name]||null,closest:selector=>selector.split(',').some(s=>region===header?s==='.large-player-header':region===info?s==='.large-player-info':s==='.large-lyrics')?region:null,
  getClientRects:()=>[{}],getBoundingClientRect:()=>({left,top,width,height}),hasAttribute:()=>false,focus:()=>{focused=id}})
 const back=el('player-back',header,24,24,150),video=el('player-video',header,800,24),queue=el('queue',header,900,24)
 // A scrolled lyric can geometrically overlap the header. It must not intercept left/right.
 const lyric=el('lyric',lyrics,550,20,400,300)
 const fullscreen=el('video-fullscreen',info,360,300,60,48,{'data-focus-left':'player-back','data-focus-up':'player-back'})
 const elements=[back,video,queue,lyric,fullscreen]
 const shell={querySelectorAll:()=>elements},main={contains:()=>true,getBoundingClientRect:()=>({top:0,bottom:700})}
 globalThis.document={querySelectorAll:()=>[],querySelector:s=>s==='.large-shell'?shell:s==='.large-main'?main:null,addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener(){}}
 globalThis.window={addEventListener(){},removeEventListener(){}}
 globalThis.getComputedStyle=()=>({visibility:'visible'})
 const cleanup=installDirectionalFocus()
 try {
  const press=(target,key)=>{focused=target.id;handlers.get('keydown')({key,target,preventDefault(){},defaultPrevented:false});return focused}
  assert.equal(press(video,'ArrowLeft'),'player-back')
  assert.equal(press(queue,'ArrowLeft'),'player-video')
  assert.equal(press(back,'ArrowRight'),'player-video')
  assert.equal(press(fullscreen,'ArrowLeft'),'player-back')
  assert.equal(press(fullscreen,'ArrowUp'),'player-back')
  assert.equal(press(back,'ArrowDown'),'video-fullscreen')
  assert.equal(press(back,'ArrowLeft'),'player-back')
 } finally {cleanup();Object.assign(globalThis,original)}
 // Verify the real JSX declares the same exit, rather than testing a fixture-only link.
 const player=await readFile('src/large-screen/Player.tsx','utf8')
 assert.match(player,/data-focus="video-fullscreen" data-focus-left="player-back" data-focus-up="player-back"/)
})
