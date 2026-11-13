import { create } from 'zustand'
export type FloatingPreferences = { fontSize:number; locked:boolean; activeColor:string; inactiveColor:string }
const color=(value:unknown,fallback:string)=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value)?value.toLowerCase():fallback
export const lyricColors=[{name:'薄荷',activeColor:'#b4f3e9',inactiveColor:'#91a6b5'},{name:'晴蓝',activeColor:'#89d5ff',inactiveColor:'#d4e4ee'},{name:'暖金',activeColor:'#ffe29a',inactiveColor:'#e2ded1'},{name:'樱粉',activeColor:'#ffc2da',inactiveColor:'#ddd5e5'}]
const key='bilimusic-floating-lyrics-style-v1'
export function readFloatingPreferences(raw:string|null):FloatingPreferences {
  try {const value=JSON.parse(raw||'{}');return{fontSize:Number.isFinite(value.fontSize)?Math.min(48,Math.max(18,Math.round(value.fontSize))):28,locked:value.locked===true,activeColor:color(value.activeColor,'#b4f3e9'),inactiveColor:color(value.inactiveColor,'#91a6b5')}}catch{return{fontSize:28,locked:false,activeColor:'#b4f3e9',inactiveColor:'#91a6b5'}}
}
function initial(){try{return readFloatingPreferences(localStorage.getItem(key))}catch{return readFloatingPreferences(null)}}
export const useFloatingPreferences=create<FloatingPreferences & {update:(value:Partial<FloatingPreferences>)=>void}>((set,get)=>({...initial(),update:value=>{
  const next=readFloatingPreferences(JSON.stringify({...get(),...value}));try{localStorage.setItem(key,JSON.stringify(next))}catch{}set(next)
}}))
window.addEventListener('storage',event=>{if(event.key===key)useFloatingPreferences.setState(readFloatingPreferences(event.newValue))})
