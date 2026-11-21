import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { LyricLine } from '../../domain/lyrics'
import { centeredLyricOffset, lyricScrollPosition } from '../../domain/lyricTimeline'

export function FloatingLyricMarquee({identity,line,active,timeMs,clock,nextTimeMs,centerSlot,children}:{identity:string;line?:LyricLine;active:boolean;timeMs:number;clock?:()=>number;nextTimeMs?:number;centerSlot?:number;children:ReactNode}) {
  const viewport=useRef<HTMLDivElement>(null),text=useRef<HTMLDivElement>(null)
  const [size,setSize]=useState({viewport:0,text:0})
  const travel=Math.max(0,size.text-size.viewport)
  useLayoutEffect(()=>{
    const measure=()=>{
      const next={viewport:viewport.current?.clientWidth||0,text:text.current?.scrollWidth||0}
      setSize(previous=>previous.viewport===next.viewport&&previous.text===next.text?previous:next)
    }
    measure()
    const observer=new ResizeObserver(measure)
    if(viewport.current)observer.observe(viewport.current)
    if(text.current)observer.observe(text.current)
    return()=>observer.disconnect()
  },[identity])
  useEffect(()=>{
    let tick=0
    const render=()=>{
      const offset=active&&line?travel*lyricScrollPosition(line,clock?.()??timeMs,nextTimeMs,size.viewport,size.text):0
      if(text.current)text.current.style.transform=`translateX(${-offset}px)`
    }
    render()
    if(active&&line&&clock&&travel>1){
      const animate=()=>{render();tick=requestAnimationFrame(animate)}
      tick=requestAnimationFrame(animate)
    }
    return()=>cancelAnimationFrame(tick)
  },[identity,line,active,timeMs,clock,nextTimeMs,travel,size.viewport,size.text])
  return <div ref={viewport} className="floating-lyric-viewport" data-overflow={travel>1||undefined} data-center-slot={centerSlot}>
    <div ref={text} className="floating-lyric-marquee" style={centerSlot===undefined?undefined:{marginLeft:centeredLyricOffset(centerSlot,size.viewport,size.text)}}>{children}</div>
  </div>
}
