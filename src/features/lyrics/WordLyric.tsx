import { useEffect, useRef, type CSSProperties } from 'react'
import type { LyricLine } from '../../services/desktopApi'
export function wordProgress(start:number,end:number,time:number) {
 return `${Math.max(0,Math.min(1,(time-start)/Math.max(1,end-start)))*100}%`
}
export function WordLyric({ line, timeMs, active, clock }: { line: LyricLine; timeMs: number; active: boolean; clock?:()=>number }) {
 const root=useRef<HTMLSpanElement>(null)
 useEffect(()=>{
  if(!active||!line.words?.length||!clock)return
  let frame=0
  const values:string[]=[]
  const paint=()=>{const now=clock();line.words!.forEach((word,index)=>{const value=wordProgress(word.startTimeMs,word.endTimeMs,now);if(values[index]!==value){values[index]=value;(root.current?.children[index] as HTMLElement|undefined)?.style.setProperty('--word-progress',value)}});frame=requestAnimationFrame(paint)}
  paint();return()=>cancelAnimationFrame(frame)
 },[active,line,clock])
 if (!active || !line.words?.length) return <>{line.text}</>
 return <span ref={root} className="word-lyric" aria-label={line.text}>{line.words.map((word,index) => <span key={index} className="lyric-word" aria-hidden="true" style={{'--word-progress':wordProgress(word.startTimeMs,word.endTimeMs,timeMs)} as CSSProperties}>{word.text}</span>)}</span>
}
