import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { listeningDuration } from '../../shared/listeningDuration'
export type ListeningBar = { key:string; label:string; seconds:number; future:boolean }

export function ListeningBars({bars,max,today,weekly}:{bars:ListeningBar[];max:number;today:string;weekly:boolean}) {
  const [selected,setSelected]=useState<string|null>(null)
  const root=useRef<HTMLDivElement>(null), tooltip=useId()
  const index=bars.findIndex(bar=>bar.key===selected), current=bars[index]
  useEffect(()=>{
    const dismiss=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setSelected(null)}
    document.addEventListener('pointerdown',dismiss)
    return()=>document.removeEventListener('pointerdown',dismiss)
  },[])
  return <>
    <div className="listening-chart-scale"><span>{listeningDuration(max===1?0:max)}</span><span>0</span></div>
    <div className="listening-chart-scroll listening-interactive-chart" ref={root} onPointerLeave={event=>{if(event.pointerType!=='touch')setSelected(null)}}>
      <div className="listening-chart" style={{'--bar-count':bars.length} as CSSProperties}>{bars.map((bar,i)=><div key={bar.key}
        role="button" tabIndex={0} className="listening-bar" data-selected={selected===bar.key||undefined} data-today={bar.key===today||undefined} data-future={bar.future||undefined}
        aria-label={`${bar.key}，${bar.future?'尚未到来':listeningDuration(bar.seconds)}`} aria-describedby={selected===bar.key?tooltip:undefined}
        onPointerEnter={()=>setSelected(bar.key)} onPointerDown={()=>setSelected(bar.key)} onClick={()=>setSelected(bar.key)} onFocus={()=>setSelected(bar.key)}
        onBlur={event=>{if(!root.current?.contains(event.relatedTarget as Node))setSelected(null)}}
        onKeyDown={event=>{
          if(event.key==='Escape'){event.preventDefault();setSelected(null);return}
          const next=event.key==='ArrowLeft'?i-1:event.key==='ArrowRight'?i+1:event.key==='Home'?0:event.key==='End'?bars.length-1:undefined
          if(next!==undefined){event.preventDefault();root.current?.querySelectorAll<HTMLElement>('.listening-bar')[Math.max(0,Math.min(bars.length-1,next))]?.focus()}
          else if(event.key===' '||event.key==='Enter'){event.preventDefault();setSelected(bar.key)}
        }}>
        <span style={{height:`${bar.seconds>0?Math.max(3,bar.seconds/max*100):2}%`}}/><small>{weekly||i===0||(i+1)%5===0||i===bars.length-1?bar.label:''}</small>
      </div>)}</div>
      {current&&<div id={tooltip} role="tooltip" className="listening-bar-tooltip" style={{left:`clamp(72px,${(index+.5)/bars.length*100}%,calc(100% - 72px))`}}><strong>{current.key.replaceAll('-',' / ')}</strong><span>{current.future?'尚未到来':current.seconds?`聆听 ${listeningDuration(current.seconds)}`:'暂无聆听'}</span></div>}
    </div>
  </>
}
