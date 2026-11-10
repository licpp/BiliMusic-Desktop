import { addPluginListener, invoke } from '@tauri-apps/api/core'
import type { Track } from '../../domain/track'

type State = { sleepDeadline?: number; sleepDuration?: number; sleepExpired?: boolean; stopped?: boolean; id?: string; status?: 'playing' | 'paused' | 'buffering' | 'error'; position?: number; duration?: number; error?: string; action?: 'next' | 'previous' | 'ended' | 'resume' }
let ready: Promise<unknown> | undefined
let consumer: (state: State) => void = () => undefined
let clock = { position: 0, at: 0, playing: false, duration: 0 }
export function observeAndroidAudio(callback: (state: State) => void) {
  consumer = callback
  if (!ready) ready = addPluginListener<State>('android-player', 'state', (state) => {
    if (state.position !== undefined) clock = { position: state.position, at: performance.now(), playing: state.status === 'playing', duration: state.duration || 0 }
    consumer(state)
  }).catch((error) => { ready = undefined; throw error })
  return ready
}
export async function playAndroidAudio(track: Track, url: string, position: number, volume: number, playing = true, collectionRef?: string) {
  await ready
  await invoke('plugin:android-player|play', { url, id: track.id, title: track.title, artist: track.artist || '歌手未知', coverUrl: track.coverUrl, position, volume, playing, collectionRef })
}
export const setAndroidCollection = (id: string, collectionRef?: string) => invoke('plugin:android-player|control', { action: 'collection', id, collectionRef })
export const controlAndroidAudio = (action: string, value = 0) => invoke('plugin:android-player|control', { action, value })
export const snapshotAndroidAudio = async () => {
  const state = await invoke<State>('plugin:android-player|snapshot')
  if (state.position !== undefined) clock = { position: state.position, at: performance.now(), playing: state.status === 'playing', duration: state.duration || 0 }
  return state
}
export function androidPlaybackClock() { return clock.position + (clock.playing ? Math.max(0, performance.now() - clock.at) / 1000 : 0) }

export const prepareAndroidAudio = (track: Track) => invoke('plugin:android-player|control', { action: 'prepare', id: track.id, title: track.title, artist: track.artist || '歌手未知', coverUrl: track.coverUrl })
