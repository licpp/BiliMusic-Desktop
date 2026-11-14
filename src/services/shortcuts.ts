import { create } from 'zustand'
import { defaultShortcuts, globalShortcutConflict, readShortcuts, shortcutActions, shortcutProblem, type Shortcut, type ShortcutAction, type ShortcutBindings } from '../features/player/shortcuts'
export const shortcutMac = /Macintosh|Mac OS X/i.test(navigator.userAgent)
export const shortcutWindows = /Windows/i.test(navigator.userAgent)
export const shortcutDesktop = shortcutMac || shortcutWindows
const storageKey='bilimusic-shortcuts-v1'
const globalKey='bilimusic-global-shortcuts-v1'
function initial() { try{return readShortcuts(localStorage.getItem(storageKey),shortcutMac,shortcutDesktop)}catch{return defaultShortcuts(shortcutMac)} }
function initialGlobal() { try{return shortcutDesktop && localStorage.getItem(globalKey)==='true'}catch{return false} }
function persist(bindings:ShortcutBindings) { localStorage.setItem(storageKey,JSON.stringify({version:1,bindings})) }
export const useShortcutStore=create<{bindings:ShortcutBindings;globalEnabled:boolean;setGlobalEnabled:(enabled:boolean)=>string|undefined;setBinding:(action:ShortcutAction,key:Shortcut|null)=>string|undefined;reset:()=>string|undefined}>((set,get)=>({
  bindings:initial(),globalEnabled:initialGlobal(),
  setGlobalEnabled:enabled=>{
    if(!shortcutDesktop)return '当前系统仅支持窗口内快捷键'
    if(enabled){for(const {id} of shortcutActions){const key=get().bindings[id];const problem=key&&globalShortcutConflict(key,get().bindings,id,shortcutMac);if(problem)return problem}}
    try{localStorage.setItem(globalKey,String(enabled))}catch{return '无法保存快捷键，请重试'}
    set({globalEnabled:enabled})
  },
  setBinding:(action,key)=>{
    if(key){const problem=shortcutProblem(key,get().bindings,action,shortcutDesktop)||(get().globalEnabled?globalShortcutConflict(key,get().bindings,action,shortcutMac):undefined);if(problem)return problem}
    const bindings={...get().bindings,[action]:key}
    try{persist(bindings)}catch{return '无法保存快捷键，请重试'}
    set({bindings})
  },
  reset:()=>{const bindings=defaultShortcuts(shortcutMac);try{persist(bindings)}catch{return '无法保存快捷键，请重试'}set({bindings})},
}))
window.addEventListener('storage',event=>{
  if(event.key===storageKey)useShortcutStore.setState({bindings:readShortcuts(event.newValue,shortcutMac,shortcutDesktop)})
  if(event.key===globalKey)useShortcutStore.setState({globalEnabled:shortcutDesktop&&event.newValue==='true'})
})
