import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, emitTo } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LockKeyhole, LockKeyholeOpen, Move, Palette, Pause, Play, SkipBack, SkipForward, X, Minus, Plus } from 'lucide-react'
import type { FloatingFrame } from '../../services/floatingLyrics'
import { readFloatingPreferences, useFloatingPreferences, type FloatingPreferences } from '../../services/floatingLyricsPreferences'
import { FloatingLyricsColors } from './FloatingLyricsColors'
import { createLyricClock } from './lyricClock'
import { lyricAt, floatingLinePair } from './lyricTimeline'
import { WordLyric } from './WordLyric'

export function FloatingLyricsWindow() {
 const [frame,setFrame]=useState<FloatingFrame|null>(null),[,setLineTick]=useState(0)
 const current=useRef<FloatingFrame|null>(null),clock=useRef(createLyricClock())
 const {fontSize,locked,activeColor,inactiveColor,update}=useFloatingPreferences()
 const lyricClock=useCallback(()=>clock.current.position(performance.now())*1000-(current.current?.biasMs||0),[])
 useEffect(()=>{
  document.documentElement.dataset.window='lyrics';document.getElementById('app-bootstrap')?.remove()
  let alive=true,seen=false,tick=0,index=-2
  const receive=(value:FloatingFrame)=>{if(!alive||value?.id===undefined)return;clock.current.update(value,performance.now());current.current=value;setFrame(value);document.documentElement.dataset.theme=value.theme
   if(value.fontSize!==undefined&&value.locked!==undefined)useFloatingPreferences.setState(readFloatingPreferences(JSON.stringify({...useFloatingPreferences.getState(),fontSize:value.fontSize,locked:value.locked,activeColor:value.activeColor??useFloatingPreferences.getState().activeColor,inactiveColor:value.inactiveColor??useFloatingPreferences.getState().inactiveColor})))
  }
  const listener=listen<FloatingFrame>('floating-lyrics-frame',event=>{seen=true;receive(event.payload)})
  void listener.then(()=>invoke<FloatingFrame>('floating_lyrics_snapshot')).then(value=>{if(!seen)receive(value)}).catch(()=>undefined)
  const animate=()=>{const next=lyricAt(current.current?.lines||[],lyricClock(),!current.current?.subtitles);if(next!==index){index=next;setLineTick(value=>value+1)}tick=requestAnimationFrame(animate)};tick=requestAnimationFrame(animate)
  return()=>{alive=false;cancelAnimationFrame(tick);void listener.then(stop=>stop())}
 },[lyricClock])
 return <FloatingLyricsSurface externalUnlock frame={frame} timeMs={lyricClock()} clock={lyricClock} fontSize={fontSize} locked={locked} activeColor={activeColor} inactiveColor={inactiveColor} update={value=>{update(value);const {fontSize,locked,activeColor,inactiveColor}=useFloatingPreferences.getState();void emitTo('main','floating-lyrics-preferences',{fontSize,locked,activeColor,inactiveColor})}} control={action=>void invoke('floating_lyrics_control',{action})} onDrag={()=>void getCurrentWindow().startDragging()} onClose={()=>void invoke('floating_lyrics_enable',{enabled:false})}/>
}
export function FloatingLyricsSurface({frame,timeMs,clock,fontSize,locked,activeColor='#b4f3e9',inactiveColor='#91a6b5',externalUnlock=false,update,control,onDrag,onClose}:{frame:FloatingFrame|null;timeMs:number;clock?:()=>number;fontSize:number;locked:boolean;activeColor?:string;inactiveColor?:string;externalUnlock?:boolean;update:(value:Partial<FloatingPreferences>)=>void;control:(action:string)=>void;onDrag:()=>void;onClose:()=>void}) {
 const [colorsOpen,setColorsOpen]=useState(false)
 const lines=frame?.lines||[],{active,line,next}=floatingLinePair(lines,timeMs,frame?.subtitles)
 return <section className="floating-lyrics-window" data-locked={locked} data-colors-open={colorsOpen&&!locked} aria-label="双行悬浮歌词" style={{'--floating-font-size':`${fontSize}px`,'--floating-active':activeColor,'--floating-inactive':inactiveColor} as CSSProperties}>
  <header className="floating-controls"><span className="floating-drag" onPointerDown={event=>{if(!locked&&event.button===0)onDrag()}}><Move size={14}/><span>{frame?.title||'BiliMusic'}</span></span><button aria-label="锁定悬浮歌词" title="锁定位置，悬停可解锁" onClick={()=>{setColorsOpen(false);update({locked:true})}}><LockKeyhole size={15}/></button><button aria-label="关闭悬浮歌词" onClick={onClose}><X size={17}/></button></header>
  {locked&&!externalUnlock&&<button className="floating-unlock" aria-label="解锁悬浮歌词" onClick={()=>update({locked:false})}><LockKeyholeOpen size={15}/><span>解锁</span></button>}
  <div className="floating-lyric-lines" onPointerDown={event=>{if(!locked&&event.button===0)onDrag()}}>
   <div className="floating-lyric-line current">{line?<WordLyric line={line} timeMs={timeMs} active={active>=0} clock={clock}/>:<span>{lines.length?'\u00a0':frame?.title||'开始播放，让歌词陪着你'}</span>}</div>
   <div className="floating-lyric-line upcoming">{next?.text||(lines.length?'\u00a0':frame?.artist||'\u00a0')}</div>
  </div>
  <footer className="floating-controls"><button aria-label="上一首" onClick={()=>control('previous')}><SkipBack size={15}/></button><button aria-label={frame?.playing?'暂停':'播放'} onClick={()=>control('toggle')}>{frame?.playing?<Pause size={16}/>:<Play size={16}/>}</button><button aria-label="下一首" onClick={()=>control('next')}><SkipForward size={15}/></button><span className="floating-tool-divider"/><button aria-label="歌词颜色" aria-expanded={colorsOpen} onClick={()=>setColorsOpen(!colorsOpen)}><Palette size={16}/></button><span className="floating-font-controls"><button aria-label="减小歌词字号" disabled={fontSize<=18} onClick={()=>update({fontSize:fontSize-2})}><Minus size={14}/></button><output aria-label="歌词字号">{fontSize}</output><button aria-label="增大歌词字号" disabled={fontSize>=48} onClick={()=>update({fontSize:fontSize+2})}><Plus size={14}/></button></span></footer>
  {colorsOpen&&!locked&&<div className="floating-colors-popover" role="group" aria-label="桌面歌词颜色"><header><span>歌词颜色</span><button aria-label="关闭颜色设置" onClick={()=>setColorsOpen(false)}><X size={14}/></button></header><FloatingLyricsColors activeColor={activeColor} inactiveColor={inactiveColor} update={update}/></div>}
 </section>
}
