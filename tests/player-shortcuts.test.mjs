import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const r=await build({entryPoints:['src/features/player/shortcuts.ts'],bundle:true,write:false,format:'esm',platform:'node'})
const {playerShortcut}=await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)
test('Mac 和 Windows 快捷键区分切歌、快进与音量，保留其他组合',()=>{
 const event={key:'ArrowRight',code:'ArrowRight',metaKey:false,ctrlKey:false,altKey:false,shiftKey:false}
 assert.equal(playerShortcut({...event,metaKey:true}),'next')
 assert.equal(playerShortcut({...event,ctrlKey:true,key:'ArrowLeft'}),'previous')
 assert.equal(playerShortcut({...event,altKey:true}),'seekForward')
 assert.equal(playerShortcut({...event,metaKey:true,key:'ArrowUp'}),'volumeUp')
 assert.equal(playerShortcut({...event,code:'Space',key:' '}),'toggle')
 assert.equal(playerShortcut({...event,metaKey:true,shiftKey:true}),undefined)
 assert.equal(playerShortcut(event),undefined)
})
