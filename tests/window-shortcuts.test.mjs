import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'

const shortcuts=await build({entryPoints:['src/domain/shortcuts.ts'],bundle:true,write:false,format:'cjs',platform:'node'})
const instantiate=output=>{const module={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);return module.exports}
const {defaultShortcuts}=instantiate(shortcuts)

const app=await build({entryPoints:['src/app/windowShortcuts.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{
 name:'window-shortcut-boundaries',setup(builder){
  const mocks={
   playerStore:'export const usePlayerStore={getState:()=>globalThis.windowShortcutPlayer}',
   globalShortcuts:'export const listenGlobalShortcuts=()=>()=>{};export const syncGlobalShortcuts=()=>{};export const showMainWindow=()=>{}',
   platform:'export const isMobile=false',
   shortcuts:'export const useShortcutStore={getState:()=>({bindings:globalThis.windowShortcutBindings,globalEnabled:false}),subscribe:()=>()=>{}}',
   installMouseShortcuts:'export const installMouseShortcuts=()=>()=>{}',
   nativeTextEditing:'export const suppressBrowserContextMenu=()=>{}',
   overlayStack:'export const dispatchBack=()=>false',
  }
  for(const [name,contents] of Object.entries(mocks))builder.onLoad({filter:new RegExp(name+'$'),namespace:'mock'},()=>({contents}))
  builder.onResolve({filter:/player\/playerStore$/},()=>({path:'playerStore',namespace:'mock'}))
  builder.onResolve({filter:/services\/globalShortcuts$/},()=>({path:'globalShortcuts',namespace:'mock'}))
  builder.onResolve({filter:/services\/platform$/},()=>({path:'platform',namespace:'mock'}))
  builder.onResolve({filter:/services\/shortcuts$/},()=>({path:'shortcuts',namespace:'mock'}))
  builder.onResolve({filter:/shared\/installMouseShortcuts$/},()=>({path:'installMouseShortcuts',namespace:'mock'}))
  builder.onResolve({filter:/shared\/nativeTextEditing$/},()=>({path:'nativeTextEditing',namespace:'mock'}))
  builder.onResolve({filter:/shared\/overlayStack$/},()=>({path:'overlayStack',namespace:'mock'}))
 }
}]})

const FIELD='input, textarea, select, [contenteditable="true"]'
function fakeTarget(kind) {
  const selectors=new Set()
  if(['text','checkbox','range'].includes(kind))selectors.add(FIELD)
  if(kind==='button'||kind==='transport')selectors.add('button, a, summary')
  if(kind==='transport')selectors.add('.dock-controls,.mini-player-controls')
  return {
    isContentEditable:false,
    closest(selector){return selectors.has(selector)?this:null},
    matches(selector){return kind==='range'&&selector==='input[type="range"]'},
  }
}
function keyboard(key,target,extra={}) {
  const code=key===' '?'Space':key
  return {key,code,target,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,repeat:false,isComposing:false,defaultPrevented:false,
    preventDefault(){this.defaultPrevented=true},getModifierState:()=>false,...extra}
}

function install({modal=false}={}) {
  const listeners={},actions=[]
  globalThis.window={addEventListener:(type,handler)=>{listeners[type]=handler},removeEventListener:()=>{}}
  globalThis.document={addEventListener:()=>{},removeEventListener:()=>{},querySelector:()=>modal?{}:null}
  globalThis.windowShortcutBindings=defaultShortcuts(false)
  globalThis.windowShortcutPlayer={progressSeconds:0,volume:.5,
    toggle:()=>actions.push('toggle'),previous:()=>actions.push('previous'),next:()=>actions.push('next'),
    seek:()=>actions.push('seek'),setVolume:()=>actions.push('volume')}
  const stop=instantiate(app).installWindowShortcuts()
  return {actions,stop,press:(key,target,extra)=>{const event=keyboard(key,target,extra);listeners.keydown(event);return event}}
}

test('Space toggles playback wherever a click leaves focus, including buttons and lyric lines',()=>{
  for(const kind of ['button','transport','custom']){
    const {actions,press}=install()
    const event=press(' ',fakeTarget(kind))
    assert.deepEqual(actions,['toggle'],kind)
    assert.equal(event.defaultPrevented,true,`${kind}: Space must not activate the focused control`)
  }
})

test('a focused slider lets Space reach playback while text fields and checkboxes keep it',()=>{
  const {actions,press}=install()
  const slider=press(' ',fakeTarget('range'))
  assert.equal(slider.defaultPrevented,true)
  assert.deepEqual(actions,['toggle'])
  for(const kind of ['text','checkbox']){
    assert.equal(press(' ',fakeTarget(kind)).defaultPrevented,false,kind)
    assert.deepEqual(actions,['toggle'],`${kind}: native Space stays with the field`)
  }
})

test('Enter keeps native activation on buttons and links while transport controls use the binding',()=>{
  const {actions,press}=install()
  const button=press('Enter',fakeTarget('button'))
  assert.deepEqual(actions,[])
  assert.equal(button.defaultPrevented,false)
})

test('an open modal suspends the global toggle so its controls keep native Space',()=>{
  const {actions,press}=install({modal:true})
  const event=press(' ',fakeTarget('button'))
  assert.deepEqual(actions,[])
  assert.equal(event.defaultPrevented,false)
})

test('holding Space does not retrigger playback and other shortcuts still reach focused buttons',()=>{
  const {actions,press}=install()
  const repeat=press(' ',fakeTarget('custom'),{repeat:true})
  assert.deepEqual(actions,[])
  assert.equal(repeat.defaultPrevented,true)
  press('ArrowLeft',fakeTarget('button'),{ctrlKey:true})
  assert.deepEqual(actions,['previous'])
})
