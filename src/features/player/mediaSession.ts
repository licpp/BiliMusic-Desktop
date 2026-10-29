import { isAndroid } from '../../services/platform'
import { usePlayerStore } from './playerStore'

export function connectMediaSession() {
  if (isAndroid) return () => undefined
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
      try { session.setPositionState({ duration: state.durationSeconds, position: Math.max(0, Math.min(state.progressSeconds, state.durationSeconds)), playbackRate: 1 }) } catch { /* Position reporting is optional in WebView runtimes. */ }
    }
  }
  sync(usePlayerStore.getState())
  const unsubscribe = usePlayerStore.subscribe((state, previous) => sync(state, previous))
  return () => { unsubscribe(); for (const action of Object.keys(actions)) { try { session.setActionHandler(action as MediaSessionAction, null) } catch { /* Unsupported action. */ } } }
}
