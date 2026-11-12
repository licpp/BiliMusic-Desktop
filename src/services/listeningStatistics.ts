import { invoke } from '@tauri-apps/api/core'
import { isMobile } from './platform'
import { inDesktopShell } from './desktopApi'
import { playbackClock, usePlayerStore } from '../features/player/playerStore'
export type ListeningPeriod = 'week' | 'month' | 'year' | 'total'
type ListeningSummary = {seconds:number; tracks:number; days:number; plays:number; top:ListeningRank[]}
export type ListeningStatistics = Record<ListeningPeriod,ListeningSummary> & {daily:{day:string;seconds:number}[]; timezone:string; sync:{lastSuccess?:string;error?:string;pending:number;uploadedBytes:number;downloadedBytes:number}}
type ListeningRank = {id:string;title:string;artist:string;coverUrl:string;seconds:number}
export const getListeningStatistics = () => invoke<ListeningStatistics>('listening_statistics')
export function startListeningStatistics() {
  if (!inDesktopShell || isMobile) return // Mobile players count inside their native playback services.
  let sessionId=crypto.randomUUID()
  let scope:string|undefined, generation=0, last=performance.now(), current=usePlayerStore.getState(), seconds=0, position=playbackClock()
  const loadScope=async()=>{const gen=++generation;const value=await invoke<string>('listening_scope');if(gen===generation)scope=value}
  void loadScope().catch(()=>undefined)
  const flush=()=>{const id=current.current?.id,value=seconds,expected=scope;seconds=0;if(id && value>0 && expected!==undefined)void invoke('listening_record',{scope:expected,trackId:id,seconds:Math.min(300,value),observedAt:Date.now(),sessionId}).catch(()=>undefined)}
  const tick=()=>{const now=performance.now(),nextPosition=playbackClock();if(current.status==='playing')seconds+=Math.max(0,Math.min((now-last)/1000,(nextPosition-position)/current.rate));last=now;position=nextPosition}
  usePlayerStore.subscribe((next)=>{if(next.current?.id!==current.current?.id || next.status!==current.status || next.rate!==current.rate){tick();flush();if(next.current?.id!==current.current?.id || next.status==='resolving')sessionId=crypto.randomUUID();current=next;last=performance.now();position=playbackClock()}})
  window.setInterval(()=>{tick();if(seconds>=15)flush()},1000)
  window.addEventListener('bilimusic-account-changed',()=>{void loadScope().catch(()=>undefined)})
  window.addEventListener('pagehide',()=>{tick();flush()})
  window.addEventListener('bilimusic-account-changing',()=>{generation++;seconds=0;scope=undefined;last=performance.now();position=playbackClock()})
}
