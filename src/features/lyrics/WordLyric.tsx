import { lyricDisplayText } from '../../domain/lyricDisplay'
import { useEffect, useRef, type CSSProperties } from 'react'
import type { LyricLine } from '../../domain/lyrics'
export function wordProgress(start:number,end:number,time:number) {
 return `${Math.max(0,Math.min(1,(time-start)/Math.max(1,end-start)))*100}%`
}
export function WordLyric({ line, timeMs, active, clock }: { line: LyricLine; timeMs: number; active: boolean; clock?:()=>number }) {
 const root=useRef<HTMLSpanElement>(null)
 useEffect(()=>{
  if(!active||!line.words?.length||!clock)return
  let frame = 0
  const paint = () => {
   if (document.hidden) return
   const now = clock()
   line.words!.forEach((word, index) => {
    const style = (root.current?.children[index] as HTMLElement | undefined)?.style
    const value = wordProgress(word.startTimeMs, word.endTimeMs, now)
    if (style && style.getPropertyValue('--word-progress') !== value) style.setProperty('--word-progress', value)
   })
   frame = requestAnimationFrame(paint)
  }
  const syncVisibility = () => {
   cancelAnimationFrame(frame)
   paint()
  }
  syncVisibility()
  document.addEventListener('visibilitychange', syncVisibility)
  return () => {
   cancelAnimationFrame(frame)
   document.removeEventListener('visibilitychange', syncVisibility)
  }
 },[active,line,clock])
 if (!active || !line.words?.length) return <>{lyricDisplayText(line.text)}</>
 return <span ref={root} className="word-lyric" aria-label={lyricDisplayText(line.text)}>{line.words.map((word,index) => <span key={index} className="lyric-word" aria-hidden="true" style={{'--word-progress':wordProgress(word.startTimeMs,word.endTimeMs,timeMs)} as CSSProperties}>{lyricDisplayText(word.text)}</span>)}</span>
}
