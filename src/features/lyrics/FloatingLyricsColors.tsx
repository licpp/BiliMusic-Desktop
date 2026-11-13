import { lyricColors, type FloatingPreferences } from '../../services/floatingLyricsPreferences'
import type { CSSProperties } from 'react'
export function FloatingLyricsColors({activeColor,inactiveColor,update,showPresetNames=false}:{activeColor:string;inactiveColor:string;update:(value:Partial<FloatingPreferences>)=>void;showPresetNames?:boolean}) {
 return <div className="floating-colors">
  <div className="floating-color-presets" role="group" aria-label="歌词配色">{lyricColors.map(color=><button key={color.name} type="button" aria-label={`${color.name}配色`} aria-pressed={activeColor===color.activeColor&&inactiveColor===color.inactiveColor} title={color.name} style={{'--swatch-color':color.activeColor} as CSSProperties} onClick={()=>update({activeColor:color.activeColor,inactiveColor:color.inactiveColor})}><span/>{showPresetNames&&<small>{color.name}</small>}</button>)}</div>
  <div className="floating-color-custom">{[{key:'activeColor',label:'已唱',value:activeColor},{key:'inactiveColor',label:'未唱',value:inactiveColor}].map(color=><label key={color.key}><span>{color.label}</span><span className="floating-color-input" style={{background:color.value}}><input aria-label={`悬浮歌词${color.label}颜色`} type="color" value={color.value} onChange={event=>update({[color.key]:event.target.value})}/></span></label>)}</div>
 </div>
}
