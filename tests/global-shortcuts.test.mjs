import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'

const code=await build({entryPoints:['src/services/globalShortcuts.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{
 name:'shortcut-boundaries',setup(builder){
  builder.onResolve({filter:/^@tauri-apps\/api\/(core|event)$/},args=>({path:args.path.split('/').at(-1),namespace:'mock'}))
  builder.onResolve({filter:/^\.\/desktopApi$/},()=>({path:'api',namespace:'mock'}))
  builder.onResolve({filter:/^\.\/shortcuts$/},()=>({path:'platform',namespace:'mock'}))
  builder.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:{
   core:'export const invoke=(...args)=>globalThis.hotkeyTest.invoke(...args)',
   event:'export const listen=(...args)=>globalThis.hotkeyTest.listen(...args)',
   api:'export const inDesktopShell=globalThis.hotkeyTest.native',
   platform:'export const shortcutDesktop=globalThis.hotkeyTest.windows||globalThis.hotkeyTest.mac',
  }[path]}))
 }
}]})
const storeCode=await build({entryPoints:['src/services/shortcuts.ts'],bundle:true,write:false,format:'cjs',platform:'node'})
function instantiate(output){const module={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);return module.exports}
const tick=()=>new Promise(setImmediate)
const key=(code,extra={})=>({code,ctrl:true,alt:false,shift:false,meta:false,...extra})
const bindings=()=>({toggle:key('Space',{ctrl:false}),previous:key('ArrowLeft'),next:key('ArrowRight'),seekBack:null,seekForward:null,volumeUp:null,volumeDown:null,listSearch:key('KeyF')})
function setup({windows=true,mac=false,native=true,listenFails=false}={}) {
 const requests=[],events=[],calls=[]
 globalThis.hotkeyTest={windows,mac,native,invoke:(command,args)=>new Promise((resolve,reject)=>{requests.push({command,args,resolve,reject})}),
  listen:async(name,handler)=>{if(listenFails)throw Error('listener unavailable');events.push(handler);return()=>calls.push('unlisten')},
 }
 return {...instantiate(code),requests,events,calls}
}
const ok=(registered=[])=>({registered,errors:[]})
test('global shortcuts are off by default and unsupported clients never call registration',async()=>{
 const client=setup();client.syncGlobalShortcuts(bindings());
 assert.deepEqual(client.requests[0].args,{enabled:false,bindings:[]});client.requests[0].resolve(ok());await tick()
 for(const options of [{windows:false},{native:false}]) {
  const other=setup(options);other.syncGlobalShortcuts(bindings(),true);assert.equal(other.requests.length,0)
 }
})
test('macOS shares opt-in registration, recording suspension and registered event delivery',async()=>{
 const client=setup({windows:false,mac:true}),actions=[]
 const stop=client.listenGlobalShortcuts(action=>actions.push(action));await tick()
 const keys={...bindings(),next:key('ArrowRight',{ctrl:false,meta:true})}
 client.syncGlobalShortcuts(keys,true)
 assert.deepEqual(client.requests[0].args.bindings.find(b=>b.action==='next'),{action:'next',...keys.next})
 client.requests[0].resolve(ok(['next']));await tick();client.events[0]({payload:'next'})
 assert.deepEqual(actions,['next'])
 client.suspendGlobalShortcuts(true);client.events[0]({payload:'next'})
 assert.deepEqual(actions,['next']);assert.equal(client.requests[1].args.enabled,false)
 client.requests[1].resolve(ok());await tick();stop()
})
test('recording, key changes and disabling serialize registration and suppress stale results',async()=>{
 const client=setup();client.syncGlobalShortcuts(bindings(),true)
 client.suspendGlobalShortcuts(true);assert.equal(client.requests.length,1)
 client.requests[0].resolve({registered:[],errors:[{action:'previous',message:'old failure'}]});await tick()
 assert.equal(client.requests.length,2);assert.equal(client.requests[1].args.enabled,false)
 assert.deepEqual(client.useGlobalShortcutStatus.getState().errors,{})
 client.suspendGlobalShortcuts(false);client.syncGlobalShortcuts({...bindings(),next:key('KeyK')},true)
 client.requests[1].resolve(ok());await tick()
 assert.equal(client.requests.length,3);assert.equal(client.requests[2].args.bindings.find(b=>b.action==='next').code,'KeyK')
 client.syncGlobalShortcuts(bindings(),false)
 client.requests[2].resolve(ok(['next']));await tick()
 assert.equal(client.requests.length,4);assert.equal(client.requests[3].args.enabled,false)
 client.requests[3].resolve(ok());await tick()
 assert.equal(client.useGlobalShortcutStatus.getState().pending,false)
 assert.deepEqual(client.useGlobalShortcutStatus.getState().registered,[])
})
test('native registration errors reach settings and failed requests can be retried',async()=>{
 const client=setup();client.syncGlobalShortcuts(bindings(),true)
 client.requests[0].reject('全局快捷键服务未能启动');await tick()
 assert.match(client.useGlobalShortcutStatus.getState().error,/未能启动/)
 client.syncGlobalShortcuts(bindings(),true);assert.equal(client.requests.length,2)
 client.requests[1].resolve({registered:['next'],errors:[{action:'previous',message:'快捷键已被占用'}]});await tick()
 assert.equal(client.useGlobalShortcutStatus.getState().error,'')
 assert.match(client.useGlobalShortcutStatus.getState().errors.previous,/占用/)
})
test('only registered playback events run; recording, disabling and disposal block them',async()=>{
 const client=setup(),actions=[];const stop=client.listenGlobalShortcuts(action=>actions.push(action));await tick()
 client.syncGlobalShortcuts(bindings(),true);client.requests[0].resolve(ok(['next']));await tick()
 for(const payload of ['next','previous','listSearch','unexpected'])client.events[0]({payload})
 assert.deepEqual(actions,['next'])
 client.suspendGlobalShortcuts(true);client.events[0]({payload:'next'})
 client.syncGlobalShortcuts(bindings(),false);client.suspendGlobalShortcuts(false);client.events[0]({payload:'next'})
 stop();client.events[0]({payload:'next'});assert.deepEqual(actions,['next']);assert.deepEqual(client.calls,['unlisten'])
 client.requests[1].resolve(ok());await tick()
})
test('event listener failures are visible instead of unhandled rejections',async()=>{
 const client=setup({listenFails:true});const stop=client.listenGlobalShortcuts(()=>{});
 client.syncGlobalShortcuts(bindings(),true);await tick()
 client.requests[0].resolve(ok(['next']));await tick()
 assert.equal(client.requests[1].args.enabled,false,'failed event delivery must release system keys')
 client.requests[1].resolve(ok());await tick()
 assert.match(client.useGlobalShortcutStatus.getState().error,/无法接收/);stop()
})
test('global mode is opt-in, persisted and rejects Enter aliases without breaking local mappings',()=>{
 const saved=new Map(),target=new EventTarget()
 Object.defineProperty(globalThis,'navigator',{value:{userAgent:'Windows NT 10.0'},configurable:true})
 globalThis.localStorage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)}
 globalThis.window=target
 const {useShortcutStore}=instantiate(storeCode)
 assert.equal(useShortcutStore.getState().globalEnabled,false)
 assert.equal(useShortcutStore.getState().setBinding('toggle',key('Enter')),undefined)
 assert.equal(useShortcutStore.getState().setBinding('next',key('NumpadEnter')),undefined)
 assert.match(useShortcutStore.getState().setGlobalEnabled(true),/冲突/)
 assert.equal(useShortcutStore.getState().globalEnabled,false)
 useShortcutStore.getState().setBinding('next',key('KeyK'))
 assert.equal(useShortcutStore.getState().setGlobalEnabled(true),undefined)
 assert.equal(useShortcutStore.getState().globalEnabled,true)
 assert.match(useShortcutStore.getState().setBinding('next',key('NumpadEnter')),/冲突/)
 assert.equal(saved.get('bilimusic-global-shortcuts-v1'),'true')
 assert.equal(instantiate(storeCode).useShortcutStore.getState().globalEnabled,true)
})
test('macOS global settings preserve distinct Enter keys and migrate only the reserved show key',()=>{
 const saved=new Map(),target=new EventTarget()
 Object.defineProperty(globalThis,'navigator',{value:{userAgent:'Macintosh'},configurable:true})
 globalThis.localStorage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)}
 globalThis.window=target
 let {useShortcutStore}=instantiate(storeCode)
 assert.equal(useShortcutStore.getState().globalEnabled,false)
 useShortcutStore.getState().setBinding('toggle',key('Enter',{ctrl:false,meta:true}))
 useShortcutStore.getState().setBinding('next',key('NumpadEnter',{ctrl:false,meta:true}))
 assert.equal(useShortcutStore.getState().setGlobalEnabled(true),undefined)
 assert.match(useShortcutStore.getState().setBinding('previous',key('KeyQ',{alt:true})),/唤出/)
 const map={...useShortcutStore.getState().bindings,previous:key('KeyQ',{alt:true})}
 saved.set('bilimusic-shortcuts-v1',JSON.stringify({version:1,bindings:map}))
 useShortcutStore=instantiate(storeCode).useShortcutStore
 assert.equal(useShortcutStore.getState().globalEnabled,true)
 assert.equal(useShortcutStore.getState().bindings.previous,null)
 assert.equal(useShortcutStore.getState().bindings.toggle.code,'Enter')
 assert.equal(useShortcutStore.getState().bindings.next.code,'NumpadEnter')
})
