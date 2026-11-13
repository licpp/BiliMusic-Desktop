import { create } from 'zustand'
import { defaultShortcuts, readShortcuts, shortcutProblem, type Shortcut, type ShortcutAction, type ShortcutBindings } from '../features/player/shortcuts'
export const shortcutMac = /Macintosh|Mac OS X/i.test(navigator.userAgent)
const storageKey='bilimusic-shortcuts-v1'
function initial() { try{return readShortcuts(localStorage.getItem(storageKey),shortcutMac)}catch{return defaultShortcuts(shortcutMac)} }
function persist(bindings:ShortcutBindings) { localStorage.setItem(storageKey,JSON.stringify({version:1,bindings})) }
export const useShortcutStore=create<{bindings:ShortcutBindings;setBinding:(action:ShortcutAction,key:Shortcut|null)=>string|undefined;reset:()=>string|undefined}>((set,get)=>({
  bindings:initial(),
  setBinding:(action,key)=>{
    if(key){const problem=shortcutProblem(key,get().bindings,action);if(problem)return problem}
    const bindings={...get().bindings,[action]:key}
    try{persist(bindings)}catch{return '无法保存快捷键，请重试'}
    set({bindings})
  },
  reset:()=>{const bindings=defaultShortcuts(shortcutMac);try{persist(bindings)}catch{return '无法保存快捷键，请重试'}set({bindings})},
}))
window.addEventListener('storage',event=>{if(event.key===storageKey)useShortcutStore.setState({bindings:readShortcuts(event.newValue,shortcutMac)})})
