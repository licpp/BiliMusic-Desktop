import { addPluginListener, invoke, type PluginListener } from '@tauri-apps/api/core'
import type { Track } from '../../domain/track'
import type { RepeatMode } from './playerStore'

export type IOSAudioState = { action?: 'next' | 'previous' | 'ended' | 'resume'; stopped?: boolean; id?: string; status?: 'playing' | 'paused' | 'buffering' | 'error'; position?: number; duration?: number; error?: string; track?: Track; revision?: number }
let ready: Promise<unknown> | undefined
let listener: PluginListener | undefined
let consumer: ((state: IOSAudioState) => void) | undefined
let listenerGeneration = 0
let lastEventAt = performance.now()
let clock = { position: 0, at: 0, playing: false, duration: 0 }
let revision = -1
function bindIOSAudio() {
  const generation = ++listenerGeneration
  return addPluginListener<IOSAudioState>('ios-player', 'state', state => {
    if (generation !== listenerGeneration) return
    lastEventAt = performance.now()
    if ((state.revision ?? 0) < revision) return
    revision = state.revision ?? 0
    if (state.position !== undefined) clock = { position: state.position, at: performance.now(), playing: state.status === 'playing', duration: state.duration || 0 }
    consumer?.(state)
  }).then(value => { listener = value; return value }).catch(error => { if (generation === listenerGeneration) ready = undefined; throw error })
}
export function observeIOSAudio(callback: (state: IOSAudioState) => void) {
  consumer = callback
  if (!ready) ready = bindIOSAudio()
  return ready
}
export async function restartIOSAudioObservation() {
  listenerGeneration += 1
  if (listener) void listener.unregister().catch(() => undefined)
  listener = undefined; ready = undefined; revision = -1
  ready = bindIOSAudio()
  await ready
  lastEventAt = performance.now()
}
export const iosListenerAge = () => performance.now() - lastEventAt
export const syncIOSQueue = (tracks: Track[], repeatMode: RepeatMode, shuffled: boolean) => invoke('plugin:ios-player|queue', { tracks, repeatMode, shuffled })
export async function playIOSAudio(track: Track, url: string, position: number, volume: number) {
  await ready
  await invoke('plugin:ios-player|play', { url, id: track.id, position, volume })
}
export const controlIOSAudio = (action: string, value = 0) => invoke('plugin:ios-player|control', { action, value })
export const snapshotIOSAudio = async () => {
  const state = await invoke<IOSAudioState>('plugin:ios-player|snapshot')
  lastEventAt = performance.now()
  if (state.position !== undefined) clock = { position: state.position, at: performance.now(), playing: state.status === 'playing', duration: state.duration || 0 }
  return state
}
export const prepareIOSAudio = (track: Track) => invoke('plugin:ios-player|control', { action: 'prepare', id: track.id })
export function iosPlaybackClock() { return Math.min(clock.duration || Infinity, clock.position + (clock.playing ? Math.max(0, performance.now() - clock.at) / 1000 : 0)) }
