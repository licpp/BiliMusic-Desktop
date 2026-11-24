import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const r=await build({stdin:{contents:"export * from './src/domain/shortcuts'; export * from './src/shared/installMouseShortcuts'",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node'})
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
const {defaultShortcuts,shortcutFromEvent,resolveShortcut,shortcutProblem,shortcutLabel,readShortcuts,globalShortcutBinding}=await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)
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


test('show is configurable and its default never steals a legacy user mapping',()=>{
 const bindings=defaultShortcuts(false),custom={code:'KeyQ',ctrl:true,alt:true,shift:false,meta:false}
 assert.equal(globalShortcutBinding('toggle',bindings.toggle),undefined)
 assert.equal(globalShortcutBinding('listSearch',bindings.listSearch),undefined)
 assert.deepEqual(globalShortcutBinding('show',bindings.show),{action:'show',...custom})
 assert.match(shortcutProblem(custom,bindings,'toggle',true),/打开窗口/)
 bindings.show=null
 assert.equal(shortcutProblem(custom,bindings,'toggle',true),undefined)
 const legacy={...bindings,toggle:custom};delete legacy.show
 const restored=readShortcuts(JSON.stringify({version:1,bindings:legacy}),false,true)
 assert.deepEqual(restored.toggle,custom);assert.equal(restored.show,null)
 assert.equal(shortcutProblem({code:'KeyJ',ctrl:false,alt:false,shift:false,meta:false},defaultShortcuts(),'show',true).includes('组合键'),true)
 assert.match(shortcutProblem({code:'MouseBack',ctrl:true,alt:false,shift:false,meta:false},defaultShortcuts(),'show',true),/鼠标侧键/)
})
test('Windows global Enter aliases conflict while window-only and numpad digits stay distinct',async()=>{
 const {globalShortcutConflict}=await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)
 const bindings=defaultShortcuts(false)
 bindings.toggle={code:'Enter',ctrl:true,alt:false,shift:false,meta:false}
 assert.match(globalShortcutConflict({...bindings.toggle,code:'NumpadEnter'},bindings,'next'),/Enter/)
 assert.equal(shortcutProblem({...bindings.toggle,code:'NumpadEnter'},bindings,'next'),undefined)
 assert.equal(globalShortcutConflict({...bindings.toggle,code:'NumpadEnter'},bindings,'next',true),undefined)
 bindings.toggle={...bindings.toggle,code:'Digit1'}
 assert.equal(globalShortcutConflict({...bindings.toggle,code:'Numpad1'},bindings,'next'),undefined)
})
const {shortcutFromMouseEvent,resolveMouseShortcut,installMouseShortcuts}=await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)
const mouseEvent=(button,extra={})=>({button,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,...extra})
test('mouse side keys support exact modifiers, readable labels, conflicts and saved mappings',()=>{
 const bindings=defaultShortcuts(false)
 bindings.previous=shortcutFromMouseEvent(mouseEvent(3));bindings.next=shortcutFromMouseEvent(mouseEvent(4,{ctrlKey:true}))
 assert.equal(resolveMouseShortcut(mouseEvent(3),bindings),'previous')
 assert.equal(resolveMouseShortcut(mouseEvent(4),bindings),undefined)
 assert.equal(resolveMouseShortcut(mouseEvent(4,{ctrlKey:true}),bindings),'next')
 assert.equal(shortcutLabel(bindings.previous),'鼠标后退键');assert.equal(shortcutLabel(bindings.next),'Ctrl + 鼠标前进键')
 assert.match(shortcutProblem(bindings.next,bindings,'toggle'),/下一首/)
 assert.deepEqual(readShortcuts(JSON.stringify({version:1,bindings})),bindings)
 for(const button of [0,1,2,5])assert.equal(shortcutFromMouseEvent(mouseEvent(button)),undefined)
})
test('side-key gesture fires once and prevents native back/forward on down, up and auxclick',()=>{
 const target=new EventTarget(),bindings=defaultShortcuts(),actions=[]
 bindings.next=shortcutFromMouseEvent(mouseEvent(4))
 const stop=installMouseShortcuts(target,()=>bindings,action=>actions.push(action),()=>false)
 const dispatch=(type,button=4)=>{const e=new Event(type,{cancelable:true});Object.assign(e,mouseEvent(button));target.dispatchEvent(e);return e.defaultPrevented}
 assert.equal(dispatch('mousedown'),true);assert.equal(dispatch('mousedown'),true)
 assert.equal(dispatch('mouseup'),true);assert.equal(dispatch('auxclick'),true);assert.deepEqual(actions,['next'])
 assert.equal(dispatch('mousedown',3),false)
 stop();assert.equal(dispatch('mousedown'),false)
})
test('a bound side key cannot navigate away from an editor or modal while its custom action is suspended',()=>{
 const target=new EventTarget(),bindings=defaultShortcuts(),actions=[]
 bindings.toggle=shortcutFromMouseEvent(mouseEvent(3))
 const stop=installMouseShortcuts(target,()=>bindings,action=>actions.push(action),()=>true)
 const e=new Event('mousedown',{cancelable:true});Object.assign(e,mouseEvent(3));target.dispatchEvent(e)
 assert.equal(e.defaultPrevented,true);assert.deepEqual(actions,[]);stop()
})

test('refresh and sync has its own configurable shortcut and never becomes a player action',()=>{
 const bindings=defaultShortcuts(true)
 assert.equal(resolveShortcut({code:'F5',key:'F5',ctrlKey:false,metaKey:false,altKey:false,shiftKey:false},bindings),'refreshSync')
 bindings.refreshSync={code:'KeyS',ctrl:false,meta:true,alt:false,shift:true}
 assert.equal(resolveShortcut({code:'KeyS',key:'S',ctrlKey:false,metaKey:true,altKey:false,shiftKey:true},bindings),'refreshSync')
})

test('adding refresh shortcut preserves an existing user binding of F5',()=>{
 const bindings=defaultShortcuts(true);delete bindings.refreshSync;bindings.toggle={code:'F5',ctrl:false,meta:false,alt:false,shift:false}
 const restored=readShortcuts(JSON.stringify({version:1,bindings}),true,true)
 assert.equal(restored.toggle.code,'F5');assert.equal(restored.refreshSync,null)
})
