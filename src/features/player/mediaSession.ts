import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isMobile } from '../../services/platform'
import { usePlayerStore } from './playerStore'

export function connectMediaSession() {
  if (isMobile) return () => undefined
  if (isTauri()) return connectDesktopMedia()
  if (!('mediaSession' in navigator)) return () => undefined
  const session = navigator.mediaSession
  const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: () => { const state = usePlayerStore.getState(); if (state.status !== 'playing' && state.status !== 'resolving') void state.toggle() },
    pause: () => { const state = usePlayerStore.getState(); if (['playing', 'buffering', 'resolving'].includes(state.status)) void state.toggle() },
    previoustrack: () => void usePlayerStore.getState().previous(),
    nexttrack: () => void usePlayerStore.getState().next(),
    seekto: (event) => { if (event.seekTime !== undefined) usePlayerStore.getState().seek(event.seekTime) },
    seekbackward: (event) => { const state = usePlayerStore.getState(); state.seek(state.progressSeconds - (event.seekOffset || 10)) },
    seekforward: (event) => { const state = usePlayerStore.getState(); state.seek(state.progressSeconds + (event.seekOffset || 10)) },
  }
  for (const [action, handler] of Object.entries(actions)) { try { session.setActionHandler(action as MediaSessionAction, handler) } catch { /* Some WebViews only support a subset of media actions. */ } }
  const sync = (state: ReturnType<typeof usePlayerStore.getState>, previous?: ReturnType<typeof usePlayerStore.getState>) => {
    if (state.current !== previous?.current && 'MediaMetadata' in window) {
      const track = state.current
      session.metadata = track ? new MediaMetadata({ title: track.title, artist: track.artist || '歌手未知', album: track.album || '', artwork: track.coverUrl ? [{ src: track.coverUrl }] : [] }) : null
    }
    session.playbackState = state.status === 'playing' ? 'playing' : state.current ? 'paused' : 'none'
    if (state.durationSeconds > 0 && Number.isFinite(state.durationSeconds)) {
      try { session.setPositionState({ duration: state.durationSeconds, position: Math.max(0, Math.min(state.progressSeconds, state.durationSeconds)), playbackRate: state.rate }) } catch { /* Position reporting is optional in WebView runtimes. */ }
    }
  }
  sync(usePlayerStore.getState())
  const unsubscribe = usePlayerStore.subscribe((state, previous) => sync(state, previous))
  return () => { unsubscribe(); for (const action of Object.keys(actions)) { try { session.setActionHandler(action as MediaSessionAction, null) } catch { /* Unsupported action. */ } } }
}

function connectDesktopMedia() {
  let stopped=false, timer:ReturnType<typeof setTimeout>|undefined, lastSent=0, lastPosition=0, lastMetadata=''
  const synchronize=()=>{
    clearTimeout(timer)
    const state=usePlayerStore.getState(), track=state.current
    const metadata=JSON.stringify([track?.id,track?.title,track?.artist,track?.album,track?.coverUrl,state.durationSeconds])
    const metadataChanged=lastMetadata!==metadata
    lastMetadata=metadata;lastSent=Date.now();lastPosition=state.progressSeconds
    void invoke('desktop_media_update',{snapshot:{id:track?.id||null,title:track?.title||'',artist:track?.artist||'歌手未知',album:track?.album||'',coverUrl:track?.coverUrl||null,duration:state.durationSeconds,position:state.progressSeconds,playing:['playing','buffering'].includes(state.status),metadataChanged}}).catch(()=>undefined)
  }
  const subscription=listen<{action:string;seconds:number}>('desktop-media-command',({payload})=>{
    if(stopped)return
    const state=usePlayerStore.getState(), playing=['playing','buffering','resolving'].includes(state.status)
    if(payload.action==='toggle'||payload.action==='play'&&!playing||payload.action==='pause'&&playing)void state.toggle()
    else if(payload.action==='next')void state.next()
    else if(payload.action==='previous')void state.previous()
    else if(payload.action==='seek')state.seek(payload.seconds)
    else if(payload.action==='seekBy')state.seek(state.progressSeconds+payload.seconds)
  }).catch(()=>undefined)
  const unsubscribe=usePlayerStore.subscribe((state,previous)=>{
    if(state.current!==previous.current||state.status!==previous.status||state.durationSeconds!==previous.durationSeconds||Date.now()-lastSent>=10000||Math.abs(state.progressSeconds-lastPosition)>12){
      clearTimeout(timer);timer=setTimeout(synchronize,80)
    }
  })
  synchronize()
  return ()=>{stopped=true;clearTimeout(timer);unsubscribe();void subscription.then(stop=>stop?.())}
}
