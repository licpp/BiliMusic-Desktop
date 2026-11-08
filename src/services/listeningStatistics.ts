import { invoke } from '@tauri-apps/api/core'
import { isIOS } from './platform'
import { inDesktopShell } from './desktopApi'
import { usePlayerStore } from '../features/player/playerStore'
export type ListeningStatistics = {week:{seconds:number;tracks:number;days:number};total:{seconds:number;tracks:number;days:number};daily:{day:string;seconds:number}[];weekTop:ListeningRank[];totalTop:ListeningRank[]}
type ListeningRank = {id:string;title:string;artist:string;coverUrl:string;seconds:number}
export const getListeningStatistics = () => invoke<ListeningStatistics>('listening_statistics')
export function startListeningStatistics() {
  if (!inDesktopShell || isIOS) return // iOS counts inside AVPlayer, including background playback.
  let scope:string|undefined, generation=0, last=performance.now(), current=usePlayerStore.getState(), seconds=0
  const loadScope=async()=>{const gen=++generation;const value=await invoke<string>('listening_scope');if(gen===generation)scope=value}
  void loadScope().catch(()=>undefined)
  const flush=()=>{const id=current.current?.id,value=seconds,expected=scope;seconds=0;if(id && value>0 && expected!==undefined)void invoke('listening_record',{scope:expected,trackId:id,seconds:Math.min(300,value)}).catch(()=>undefined)}
  const tick=()=>{const now=performance.now();if(current.status==='playing')seconds+=Math.min(5,Math.max(0,now-last)/1000);last=now}
  usePlayerStore.subscribe((next)=>{if(next.current?.id!==current.current?.id || next.status!==current.status){tick();flush();current=next;last=performance.now()}})
  window.setInterval(()=>{tick();if(seconds>=15)flush()},1000)
  window.addEventListener('pagehide',()=>{tick();flush()})
  window.addEventListener('bilimusic-account-changing',()=>{seconds=0;scope=undefined;last=performance.now();void loadScope().catch(()=>undefined)})
}
