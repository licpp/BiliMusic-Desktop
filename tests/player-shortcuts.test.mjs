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
const {defaultShortcuts,shortcutFromEvent,resolveShortcut,shortcutProblem,shortcutLabel,readShortcuts}=await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)
const keyEvent=(code,modifiers={})=>({code,key:code.startsWith('Key')?code.slice(3).toLowerCase():code,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,...modifiers})
test('custom shortcuts support single keys and exact modifier combinations without triggering on composition',()=>{
 const bindings=defaultShortcuts(false)
 bindings.toggle=shortcutFromEvent(keyEvent('KeyJ'))
 bindings.next=shortcutFromEvent(keyEvent('KeyK',{ctrlKey:true,shiftKey:true}))
 assert.equal(resolveShortcut(keyEvent('KeyJ'),bindings),'toggle')
 assert.equal(resolveShortcut(keyEvent('KeyJ',{shiftKey:true}),bindings),undefined)
 assert.equal(resolveShortcut(keyEvent('KeyK',{ctrlKey:true}),bindings),undefined)
 assert.equal(resolveShortcut(keyEvent('KeyK',{ctrlKey:true,shiftKey:true}),bindings),'next')
 assert.equal(resolveShortcut(keyEvent('Space'),bindings),undefined,'changing a shortcut removes the old binding')
 assert.equal(resolveShortcut(keyEvent('KeyJ',{isComposing:true}),bindings),undefined)
 assert.equal(resolveShortcut(keyEvent('KeyJ',{getModifierState:name=>name==='AltGraph'}),bindings),undefined)
 assert.equal(shortcutFromEvent(keyEvent('ShiftLeft',{key:'Shift'})),undefined)
 assert.equal(shortcutFromEvent(keyEvent('Tab')),undefined)
 assert.equal(shortcutFromEvent(keyEvent('KeyE',{key:'Dead',altKey:true})),undefined)
})
test('shortcut conflicts, reserved keys, clearing and persistence are checked consistently',()=>{
 const bindings=defaultShortcuts(true)
 assert.match(shortcutProblem(bindings.next,bindings,'toggle'),/下一首/)
 assert.match(shortcutProblem(shortcutFromEvent(keyEvent('KeyQ',{metaKey:true})),bindings,'toggle'),/系统/)
 assert.match(shortcutProblem(shortcutFromEvent(keyEvent('F4',{altKey:true})),bindings,'toggle'),/系统/)
 bindings.toggle=shortcutFromEvent(keyEvent('KeyJ'))
 bindings.previous=null
 const saved=JSON.stringify({version:1,bindings})
 assert.deepEqual(readShortcuts(saved,true),bindings)
 assert.equal(shortcutLabel(bindings.toggle,true),'J')
 assert.equal(shortcutLabel(bindings.next,true),'⌘ + →')
 assert.equal(shortcutLabel(null),'未设置')
 assert.deepEqual(readShortcuts('{broken',true),defaultShortcuts(true))
 assert.deepEqual(readShortcuts(JSON.stringify({version:2,bindings}),true),defaultShortcuts(true))
 bindings.previous=bindings.next
 assert.deepEqual(readShortcuts(JSON.stringify({version:1,bindings}),true),defaultShortcuts(true))
})
