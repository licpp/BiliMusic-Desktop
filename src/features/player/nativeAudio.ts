import { addPluginListener, invoke } from '@tauri-apps/api/core'
import type { Track } from '../../domain/track'

type State = { sleepDeadline?: number; sleepDuration?: number; sleepExpired?: boolean; stopped?: boolean; id?: string; status?: 'playing' | 'paused' | 'buffering' | 'error'; position?: number; rate?: number; duration?: number; error?: string; action?: 'next' | 'previous' | 'ended' | 'resume' }
export function createNativeAudio(plugin: string, bind?: (callback: (state: State) => void) => Promise<unknown>) {
  let ready: Promise<unknown> | undefined
  let consumer: (state: State) => void = () => undefined
  let clock = { position: 0, at: 0, playing: false, rate: 1, duration: 0 }
  function observe(callback: (state: State) => void) {
    consumer = callback
    const receive = (state: State) => {
      if (state.position !== undefined) clock = { position: state.position, at: performance.now(), playing: state.status === 'playing', rate: state.rate ?? 1, duration: state.duration || 0 }
      consumer(state)
    }
    if (!ready) ready = (bind ? bind(receive) : addPluginListener<State>(plugin, 'state', receive)).catch((error) => { ready = undefined; throw error })
    return ready
  }
  async function play(track: Track, url: string, position: number, volume: number, playing = true, collectionRef?: string, rate = 1) {
    await ready
    await invoke(`plugin:${plugin}|play`, { url, id: track.id, title: track.title, artist: track.artist || '歌手未知', coverUrl: track.coverUrl, position, volume, playing, collectionRef, rate })
  }
  const setCollection = (id: string, collectionRef?: string) => invoke(`plugin:${plugin}|control`, { action: 'collection', id, collectionRef })
  const control = (action: string, value = 0) => invoke(`plugin:${plugin}|control`, { action, value })
  const snapshot = async () => {
    const state = await invoke<State>(`plugin:${plugin}|snapshot`)
    if (state.position !== undefined) clock = { position: state.position, at: performance.now(), playing: state.status === 'playing', rate: state.rate ?? 1, duration: state.duration || 0 }
    return state
  }
  function playbackClock() { return clock.position + (clock.playing ? Math.max(0, performance.now() - clock.at) * clock.rate / 1000 : 0) }

  const prepare = (track: Track) => invoke(`plugin:${plugin}|control`, { action: 'prepare', id: track.id, title: track.title, artist: track.artist || '歌手未知', coverUrl: track.coverUrl })

  return { observe, play, setCollection, control, snapshot, playbackClock, prepare }
}
