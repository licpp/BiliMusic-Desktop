import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Captions, Heart, ListMusic, Maximize2, Pause, Play, SkipBack, SkipForward, Volume2, X } from 'lucide-react'
import { getStoredLyrics, inDesktopShell, type StoredLyrics } from '../../services/desktopApi'
import { setMiniPlayerPanel } from '../../services/immersiveWindow'
import { parseLrc } from '../lyrics/lrc'
import { Artwork } from '../../shared/Artwork'
import { RangeControl } from '../../shared/RangeControl'
import { formatDuration } from '../../shared/time'
import { usePlayerStore } from './playerStore'

type Props = { busy: boolean; onRestore: (lyrics?: boolean, queue?: boolean) => void; onFavorite: () => void; favoritePending: boolean; onError: (cause: unknown) => void }
export function MiniPlayer({busy,onRestore,onFavorite,favoritePending,onError}: Props) {
  const current=usePlayerStore(state=>state.current)
  const status=usePlayerStore(state=>state.status)
  const volume=usePlayerStore(state=>state.volume)
  const [volumeOpen,setVolumeOpen]=useState(false)
  const [queueOpen,setQueueOpen]=useState(false)
  const [lyricsVisible,setLyricsVisible]=useState(true)
  const root=useRef<HTMLElement>(null)
  const active=status==='playing'||status==='resolving'||status==='buffering'
  useEffect(()=>{root.current?.focus({preventScroll:true})},[])
  useEffect(()=>{
    void setMiniPlayerPanel(queueOpen).catch(cause=>{setQueueOpen(false);onError(cause)})
  },[queueOpen])
  useEffect(()=>()=>{void setMiniPlayerPanel(false).catch(()=>undefined)},[])
  useEffect(()=>{
    if(!volumeOpen)return
    const close=(event:PointerEvent)=>{if(!(event.target as Element).closest('.mini-volume-group'))setVolumeOpen(false)}
    window.addEventListener('pointerdown',close)
    return()=>window.removeEventListener('pointerdown',close)
  },[volumeOpen])
  return <section ref={root} className="mini-player" data-queue-open={queueOpen||undefined} data-tauri-drag-region aria-label="迷你播放器" tabIndex={-1} onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(volumeOpen)setVolumeOpen(false);else if(queueOpen)setQueueOpen(false);else onRestore()}
  }}>
    <div className="mini-player-drag" data-tauri-drag-region aria-hidden="true"/>
    <div className="mini-window-actions">
      <button type="button" title="隐藏播放器" aria-label="隐藏播放器" onClick={()=>{if(inDesktopShell)void getCurrentWindow().hide().catch(onError);else onRestore()}}><X size={13}/></button>
      <button type="button" title="恢复完整窗口" aria-label="恢复完整窗口" disabled={busy} onClick={()=>onRestore()}><Maximize2 size={12}/></button>
    </div>
    <button className="mini-artwork-button" title="切换歌词显示" aria-label="切换歌词显示" disabled={!current||busy} onClick={()=>setLyricsVisible(value=>!value)}><Artwork src={current?.coverUrl} adaptAspect/></button>
    <div className="mini-player-info" data-tauri-drag-region>
      <MarqueeText text={current?.title||'BiliMusic'} title/>
      <MiniLyric visible={lyricsVisible}/>
    </div>
    <div className="mini-player-controls">
      <button className={current?.liked?'liked':''} type="button" disabled={!current} aria-busy={favoritePending} aria-pressed={Boolean(current?.liked)} title={current?.liked?'取消喜欢':'喜欢'} aria-label={current?.liked?'取消喜欢':'喜欢'} onClick={onFavorite}><Heart size={19} fill={current?.liked?'currentColor':'none'}/></button>
      <button type="button" title="上一首" aria-label="上一首" disabled={!current} onClick={()=>void usePlayerStore.getState().previous()}><SkipBack size={17} fill="currentColor"/></button>
      <button type="button" className="mini-play-toggle" title={active?'暂停':'播放'} aria-label={active?'暂停':'播放'} disabled={!current} onClick={()=>void usePlayerStore.getState().toggle()}>{active?<Pause size={21} fill="currentColor"/>:<Play size={21} fill="currentColor"/>}</button>
      <button type="button" title="下一首" aria-label="下一首" disabled={!current} onClick={()=>void usePlayerStore.getState().next()}><SkipForward size={17} fill="currentColor"/></button>
      <button type="button" title="迷你播放队列" aria-label="迷你播放队列" aria-expanded={queueOpen} disabled={busy} onClick={()=>setQueueOpen(value=>!value)}><ListMusic size={17}/></button>
      <button type="button" title="显示歌词" aria-label="显示歌词" aria-pressed={lyricsVisible} disabled={!current||busy} onClick={()=>setLyricsVisible(value=>!value)}><Captions size={17}/></button>
      <div className="mini-volume-group"><button type="button" title="音量" aria-label="音量" aria-expanded={volumeOpen} onClick={()=>setVolumeOpen(value=>!value)}><Volume2 size={18}/></button>{volumeOpen&&<div className="mini-volume-panel"><RangeControl aria-label="迷你播放器音量" min={0} max={1} step={.01} value={volume} onChange={event=>usePlayerStore.getState().setVolume(Number(event.target.value))}/><small>{Math.round(volume*100)}%</small></div>}</div>
    </div>
    <MiniProgress/>
    {queueOpen&&<MiniQueue/>}
  </section>
}
function MiniQueue(){
  const queue=usePlayerStore(state=>state.queue)
  const current=usePlayerStore(state=>state.current)
  const panel=useRef<HTMLDivElement>(null)
  useEffect(()=>{panel.current?.querySelector('[aria-current="true"]')?.scrollIntoView({block:'nearest'})},[current?.id,queue.length])
  return <div ref={panel} className="mini-queue" aria-label="迷你播放队列"><header><span>播放队列</span><small>{queue.length} 首</small></header>{queue.map((track,index)=><button key={track.id} type="button" aria-current={track.id===current?.id||undefined} onClick={()=>void usePlayerStore.getState().playFromList(queue,track.id,usePlayerStore.getState().queueSource)}><span>{index+1}</span><strong>{track.title}</strong><small>{formatDuration(track.durationSeconds)}</small></button>)}{!queue.length&&<p>暂无歌曲</p>}</div>
}
function MiniLyric({visible}:{visible:boolean}){
  const track=usePlayerStore(state=>state.current)
  const position=usePlayerStore(state=>state.progressSeconds)
  const client=useQueryClient()
  const stored=useQuery({queryKey:['mini-lyrics',track?.id],queryFn:()=>getStoredLyrics(track!.id),enabled:visible&&!!track&&inDesktopShell,staleTime:60000})
  useEffect(()=>{
    const update=(event:Event)=>{const value=(event as CustomEvent<StoredLyrics>).detail;if(value?.trackId===track?.id)client.setQueryData(['mini-lyrics',track?.id],value)}
    window.addEventListener('bilimusic-lyrics-updated',update)
    return()=>window.removeEventListener('bilimusic-lyrics-updated',update)
  },[track?.id,client])
  const lines=useMemo(()=>stored.data?parseLrc(stored.data.rawText):[],[stored.data])
  const time=position*1000-(stored.data?.biasMs||0)
  let line=''
  if(visible)for(const item of lines){if(item.timeMs>time)break;line=item.text}
  return <MarqueeText text={line||(track?track.artist||'歌手未知':'选择歌曲，开始聆听')}/>
}
function MarqueeText({text,title=false}:{text:string;title?:boolean}){
  const element=useRef<HTMLDivElement>(null)
  const [overflow,setOverflow]=useState(false)
  useEffect(()=>{
    const measure=()=>{const node=element.current,span=node?.firstElementChild?.firstElementChild;if(node&&span)setOverflow(span.getBoundingClientRect().width-parseFloat(getComputedStyle(span).paddingRight||'0')>node.clientWidth+1)}
    measure();const observer=new ResizeObserver(measure);if(element.current)observer.observe(element.current);return()=>observer.disconnect()
  },[text])
  return <div ref={element} className={`mini-marquee${title?' mini-track-title':''}${overflow?' scrolling':''}`} title={text} data-tauri-drag-region><div key={text} className="mini-marquee-track" data-tauri-drag-region style={{'--marquee-duration':`${Math.max(10,text.length*.3)}s`} as CSSProperties}><span data-tauri-drag-region>{text}</span>{overflow&&<span aria-hidden="true" data-tauri-drag-region>{text}</span>}</div></div>
}
function MiniProgress(){
  const position=usePlayerStore(state=>state.progressSeconds)
  const duration=usePlayerStore(state=>state.durationSeconds)
  return <div className="mini-player-progress" title={`${formatDuration(position)} / ${formatDuration(duration)}`}><RangeControl aria-label="迷你播放器播放进度" min={0} max={Math.max(1,duration)} step={.1} value={Math.min(position,duration||0)} onChange={event=>usePlayerStore.getState().seek(Number(event.target.value))}/></div>
}
