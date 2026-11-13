import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export function FloatingLyricMarquee({identity,children}:{identity:string;children:ReactNode}) {
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
  return <div ref={viewport} className="floating-lyric-viewport" data-overflow={travel>1||undefined}>
    <div key={identity} ref={text} className="floating-lyric-marquee" style={{'--lyric-travel':`${travel}px`,'--lyric-scroll-duration':`${Math.max(5,travel/32+3)}s`} as CSSProperties}>{children}</div>
  </div>
}
