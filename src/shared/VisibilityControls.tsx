import { Eye, EyeOff, RotateCcw } from 'lucide-react'
import type { Track } from '../domain/track'
import { trackHidden, visibilityChange, type VisibilityRule } from '../domain/contentVisibility'
import { saveVisibility } from '../services/contentVisibility'
import { useState } from 'react'
export function VisibilityControls({scope, rules, shown, onShow, tracks, hiddenCount, exitLabel}: {exitLabel?:string;hiddenCount?:number;scope:string;rules:VisibilityRule[];shown:boolean;onShow:(shown:boolean)=>void;tracks:readonly Track[]}) {
  const [error,setError] = useState(''), [busy,setBusy]=useState(false)
  const hidden = hiddenCount ?? tracks.filter(t=>trackHidden(t,scope,rules)).length
  const label = `${shown?'收起已隐藏':'管理隐藏'}${hidden?` · ${hidden}`:''}`
  const relevant = rules.filter(r=>r.hidden && (r.scope===scope || scope.startsWith('season:') && tracks.some(t=>r.scope===`video:${t.source.bvid}`)))
  return <div className="visibility-tools">
    <button type="button" className="collection-flat-button" aria-label={shown && exitLabel ? `${exitLabel}，${label}` : label} title={label} aria-pressed={shown} onClick={()=>onShow(!shown)}>{shown?<Eye size={16}/>:<EyeOff size={16}/>}<span>{shown && exitLabel ? exitLabel : label}</span></button>
    {shown && relevant.length>0 && <button type="button" className="collection-flat-button" aria-label="全部恢复" title="全部恢复" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await saveVisibility(relevant.map(r=>({...r,hidden:false})))}catch(e){setError(String(e))}finally{setBusy(false)}}}><RotateCcw size={16}/><span>全部恢复</span></button>}
    {error && <span role="alert" className="inline-error">{error}</span>}
  </div>
}
export function HideAction({track,scope,rules,onDone}: {track:Track;scope:string;rules:VisibilityRule[];onDone?:()=>void}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const hidden=trackHidden(track,scope,rules)
 return <><button type="button" role="menuitem" disabled={busy} onClick={async()=>{setBusy(true);try{await saveVisibility([visibilityChange(track,scope,!hidden)]);onDone?.()}catch(e){setError(String(e))}finally{setBusy(false)}}}>{hidden?<Eye size={16}/>:<EyeOff size={16}/>}<span>{hidden?'恢复显示':scope.startsWith('season:')?'在此合集中隐藏':'隐藏此分 P'}</span></button>{error&&<p role="alert" className="inline-error">{error}</p>}</>
}
