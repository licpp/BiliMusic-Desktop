import { contentTitle, type SourceTitleContext } from '../domain/sourceTitle'
import { invoke } from '@tauri-apps/api/core'
import { isMobile } from './platform'
import { inDesktopShell } from './desktopApi'
import { playbackClock, usePlayerStore } from '../features/player/playerStore'
import { randomUuid } from '../shared/randomUuid'
export type ListeningPeriod = 'week' | 'month' | 'year' | 'total'
type ListeningSummary = {seconds:number; tracks:number; days:number; plays:number; top:ListeningRank[]}
type PreferenceItem = {id:string; label:string; seconds:number}
export type ListeningPreferences = { artists: PreferenceItem[]; uploaders: PreferenceItem[]; themes: PreferenceItem[]; artistSeconds: number; uploaderSeconds: number; themeSeconds: number }
export type ListeningStatistics = Record<ListeningPeriod,ListeningSummary> & {preferences?:ListeningPreferences; daily:{day:string;seconds:number}[]; timezone:string; sync:{uid:string;provider:'cloud'|'webdav'|null;paused:boolean;enabled:boolean;lastSuccess?:string;error?:string;pending:number;uploadedBytes:number;downloadedBytes:number}}
type ListeningRank = {id:string;title:string;artist:string;coverUrl:string;seconds:number;titleOverridden?:boolean;sourceTitleContext?:SourceTitleContext;uploaderName?:string}
export const getListeningStatistics = async () => {
  const report = await invoke<ListeningStatistics>('listening_statistics')
  for (const period of ['week','month','year','total'] as const) report[period] = {...report[period],top:report[period].top.map(item=>({...item,title:!item.titleOverridden && item.sourceTitleContext ? contentTitle(item.sourceTitleContext) : item.title}))}
  return report
}
export function startListeningStatistics() {
  if (!inDesktopShell || isMobile) return // Mobile players count inside their native playback services.
  let sessionId=randomUuid()
  if (!sessionId) return
  let scope:string|undefined, generation=0, last=performance.now(), current=usePlayerStore.getState(), seconds=0, position=playbackClock()
  const loadScope=async()=>{const gen=++generation;const value=await invoke<string>('listening_scope');if(gen===generation)scope=value}
  void loadScope().catch(()=>undefined)
  const flush=()=>{const id=current.current?.id,value=seconds,expected=scope;seconds=0;if(id && value>0 && expected!==undefined && sessionId)void invoke('listening_record',{scope:expected,trackId:id,seconds:Math.min(300,value),observedAt:Date.now(),sessionId}).catch(()=>undefined)}
  const tick=()=>{const now=performance.now(),nextPosition=playbackClock();if(current.status==='playing')seconds+=Math.max(0,Math.min((now-last)/1000,(nextPosition-position)/current.rate));last=now;position=nextPosition}
  const unsubscribe = usePlayerStore.subscribe((next)=>{if(next.current?.id!==current.current?.id || next.status!==current.status || next.rate!==current.rate){tick();flush();if(next.current?.id!==current.current?.id || next.status==='resolving')sessionId=randomUuid();current=next;last=performance.now();position=playbackClock()}})
  const timer = window.setInterval(()=>{tick();if(seconds>=15)flush()},1000)
  const accountChanged = () => { void loadScope().catch(()=>undefined) }
  const pageHidden = () => { tick(); flush() }
  const accountChanging = () => { generation++; seconds=0; scope=undefined; last=performance.now(); position=playbackClock() }
  window.addEventListener('bilimusic-account-changed', accountChanged)
  window.addEventListener('pagehide', pageHidden)
  window.addEventListener('bilimusic-account-changing', accountChanging)
  return () => {
    unsubscribe()
    window.clearInterval(timer)
    window.removeEventListener('bilimusic-account-changed', accountChanged)
    window.removeEventListener('pagehide', pageHidden)
    window.removeEventListener('bilimusic-account-changing', accountChanging)
    pageHidden()
    accountChanging()
  }
}
