import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LyricLine } from '../../services/desktopApi'
import { lyricScrollProgress } from './lyricTimeline'

export function FloatingLyricMarquee({identity,line,active,timeMs,clock,nextTimeMs,children}:{identity:string;line?:LyricLine;active:boolean;timeMs:number;clock?:()=>number;nextTimeMs?:number;children:ReactNode}) {
  const viewport=useRef<HTMLDivElement>(null),text=useRef<HTMLDivElement>(null)
  const [travel,setTravel]=useState(0)
  useEffect(()=>{
    const measure=()=>setTravel(Math.max(0,(text.current?.scrollWidth||0)-(viewport.current?.clientWidth||0)))
    measure()
    const observer=new ResizeObserver(measure)
    if(viewport.current)observer.observe(viewport.current)
    if(text.current)observer.observe(text.current)
    return()=>observer.disconnect()
  },[identity])
  useEffect(()=>{
    let tick=0
    const render=()=>{
      const offset=active&&line?travel*lyricScrollProgress(line,clock?.()??timeMs,nextTimeMs):0
      if(text.current)text.current.style.transform=`translateX(${-offset}px)`
    }
    render()
    if(active&&line&&clock&&travel>1){
      const animate=()=>{render();tick=requestAnimationFrame(animate)}
      tick=requestAnimationFrame(animate)
    }
    return()=>cancelAnimationFrame(tick)
  },[identity,line,active,timeMs,clock,nextTimeMs,travel])
  return <div ref={viewport} className="floating-lyric-viewport" data-overflow={travel>1||undefined}>
    <div ref={text} className="floating-lyric-marquee">{children}</div>
  </div>
}
