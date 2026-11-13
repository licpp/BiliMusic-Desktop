import { createNativeClock } from './nativeClock'
import { addPluginListener, invoke } from '@tauri-apps/api/core'
import type { Track } from '../../domain/track'

type State = { sleepDeadline?: number; sleepDuration?: number; sleepExpired?: boolean; revision?: number; sequence?: number; seekRevision?: number; stopped?: boolean; floatingLyricsEnabled?: boolean; floatingLyricsFontSize?: number; floatingLyricsStyleRevision?: number; floatingLyricsLocked?: boolean; id?: string; status?: 'playing' | 'paused' | 'buffering' | 'error'; position?: number; rate?: number; duration?: number; error?: string; action?: 'next' | 'previous' | 'ended' | 'resume' }
export function createNativeAudio(plugin: string, bind?: (callback: (state: State) => void) => Promise<unknown>) {
  let ready: Promise<unknown> | undefined
  let consumer: (state: State) => void = () => undefined
  const clock = createNativeClock()
  let latest: State | undefined
  const accept = (state: State) => !latest || (state.revision ?? 0) > (latest.revision ?? 0) || (state.revision ?? 0) === (latest.revision ?? 0) && (state.sequence === undefined || state.sequence >= (latest.sequence ?? 0))
  function observe(callback: (state: State) => void) {
    consumer = callback
    const receive = (state: State) => {
      // Commands are events, not clock samples. Older Android players send
      // action-only packets; comparing their absent revision with the latest
      // playback revision silently dropped notification/headset navigation.
      if (state.action) {
        if (state.revision !== undefined && !accept(state)) return
        consumer(state)
        return
      }
      if (!accept(state)) return
      latest=state
      clock.update(state, performance.now())
      consumer(state)
    }
    if (!ready) ready = (bind ? bind(receive) : addPluginListener<State>(plugin, 'state', receive)).catch((error) => { ready = undefined; throw error })
    return ready
  }
  async function play(track: Track, url: string, position: number, volume: number, playing = true, collectionRef?: string, rate = 1, seamless = false) {
    await ready
    await invoke(`plugin:${plugin}|play`, { url, id: track.id, title: track.title, artist: track.artist || '歌手未知', coverUrl: track.coverUrl, position, volume, playing, collectionRef, rate, ...(seamless?{seamless:true}:{}) })
  }
  const setCollection = (id: string, collectionRef?: string) => invoke(`plugin:${plugin}|control`, { action: 'collection', id, collectionRef })
  const control = (action: string, value = 0) => invoke(`plugin:${plugin}|control`, { action, value })
  const snapshot = async () => {
    const state = await invoke<State>(`plugin:${plugin}|snapshot`)
    if (!accept(state)) return latest!
    latest=state
    clock.update(state, performance.now())
    return state
  }
  function playbackClock() { return clock.position(performance.now()) }

  const prepare = (track: Track) => invoke(`plugin:${plugin}|control`, { action: 'prepare', id: track.id, title: track.title, artist: track.artist || '歌手未知', coverUrl: track.coverUrl })

  return { observe, play, setCollection, control, snapshot, playbackClock, prepare }
}
