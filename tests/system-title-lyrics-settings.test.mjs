import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
const stubComponents=['WindowCloseSettings','ShortcutSettings','FloatingLyricsSettings','UpdateSettings','PlaybackCacheSettings','ResumeSettings','LoudnessSettings','SyncSettings','AndroidDownloadDestinationField','SettingsDisclosure']
const mocks={
 platform:`export const isIOS=globalThis.titleLyricsTestPlatform==='ios';export const isAndroid=globalThis.titleLyricsTestPlatform==='android';export const isOHOS=globalThis.titleLyricsTestPlatform==='ohos';export const isMobile=isIOS||isAndroid||isOHOS;`,
 query:'export const useQuery=()=>({});',keys:'export const accountQueryKey=(...args)=>args;',
 theme:"export const useThemeStore=select=>select({theme:'light',setTheme(){}});",
 attention:'export const useSyncAttention=select=>select({library:null,statistics:null,reveal:0});',
 api:'export const commandErrorMessage=String;export const inDesktopShell=false;',
 settings:"export const chooseDownloadDirectory=async()=>'';export const getDownloadDirectory=async()=>'';",
 sync:'export const syncStatus=async()=>({});',floating:'export const setSystemTitleLyrics=async()=>{};',
 components:stubComponents.map(name=>`export const ${name}=()=>null;`).join('\n'),
}
const output=await build({entryPoints:['src/features/settings/SettingsView.tsx'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',plugins:[{name:'settings-platform',setup(b){
 const patterns=[[/services\/platform$/,'platform'],[/^@tanstack\/react-query$/,'query'],[/services\/queryKeys$/,'keys'],[/services\/theme$/,'theme'],[/services\/syncAttention$/,'attention'],[/services\/desktopApi$/,'api'],[/services\/settings$/,'settings'],[/services\/sync$/,'sync'],[/services\/floatingLyrics$/,'floating'],[new RegExp('/('+stubComponents.map(n=>n==='AndroidDownloadDestinationField'?'AndroidDownloadDestination':n).join('|')+')$'),'components']]
 for(const[filter,path]of patterns)b.onResolve({filter},()=>({path,namespace:'mock'}))
 b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:mocks[path]}))
}}]})
test('iOS settings omit system title lyrics even when the old preference is enabled; other mobile platforms retain it',()=>{
 const saved={localStorage:globalThis.localStorage,titleLyricsTestPlatform:globalThis.titleLyricsTestPlatform}
 try{
  globalThis.localStorage={getItem:key=>key==='system-title-lyrics'?'true':null}
  for(const platform of ['ios','android','ohos','desktop']){
   globalThis.titleLyricsTestPlatform=platform
   const m={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
   const html=renderToStaticMarkup(React.createElement(m.exports.SettingsView))
   assert.equal(html.includes('系统标题歌词'),platform==='android'||platform==='ohos',platform)
   if(platform==='android'||platform==='ohos')assert.match(html,/aria-checked="true"/)
  }
 }finally{Object.assign(globalThis,saved)}
})
test('iOS native metadata has no persisted title-mode override and clients cannot re-enable it',async()=>{
 const native=await readFile('native/ios-player/ios/Sources/PlayerPlugin.swift','utf8')
 assert.doesNotMatch(native,/systemTitleLyrics|bilimusic-system-title-lyrics/)
 const service=await readFile('src/services/floatingLyrics.ts','utf8')
 assert.match(service,/if \(isMobile && !isIOS\) void setSystemTitleLyrics/)
 assert.match(service,/if \(!isMobile \|\| isIOS\) return Promise.resolve\(\)/)
})
