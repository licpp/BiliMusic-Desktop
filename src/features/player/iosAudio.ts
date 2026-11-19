import { useLoudnessSettings } from '../../services/loudness'
import type { NativeControlAction } from './contracts'
import { normalizeNativeSnapshot } from './contracts'
import { createSnapshotOrder } from './snapshotOrder'
import { nativeQueueEnvelope } from './nativeQueue'
import { sourceTrack } from '../../domain/importedPresentation'
import { addPluginListener,invoke,type PluginListener } from '@tauri-apps/api/core'
import type { Track } from '../../domain/track'
import { createNativeClock } from './nativeClock'
import type { QueueSource,RepeatMode } from './playerStore'
import type { AutomaticResumePolicy,ResumeThreshold } from './resumePolicy'

import type { NativeAudioState as IOSAudioState, PlayerSnapshot } from './contracts'
export type { NativeAudioState as IOSAudioState } from './contracts'

let ready: Promise<unknown> | undefined
let listener: PluginListener | undefined
let consumer: ((state: PlayerSnapshot) => void) | undefined
let listenerGeneration = 0
let lastEventAt = performance.now()
const clock = createNativeClock()
const order = createSnapshotOrder()
function bindIOSAudio() {
  const generation = ++listenerGeneration
  return addPluginListener<IOSAudioState>('ios-player', 'state', state => {
    if (generation !== listenerGeneration) return
    if (!order.accept(state)) return
    lastEventAt = performance.now()
    clock.update(state, performance.now())
    consumer?.(normalizeNativeSnapshot(state))
  }).then(value => { listener = value; return value }).catch(error => { if (generation === listenerGeneration) ready = undefined; throw error })
}
export function observeIOSAudio(callback: (state: PlayerSnapshot) => void) {
  consumer = callback
  if (!ready) ready = bindIOSAudio()
  return ready
}
export async function restartIOSAudioObservation() {
  listenerGeneration += 1
  if (listener) void listener.unregister().catch(() => undefined)
  listener = undefined; ready = undefined
  ready = bindIOSAudio()
  await ready
  lastEventAt = performance.now()
}
export const iosListenerAge = () => performance.now() - lastEventAt
export const setIOSCollection = (id: string, collectionRef?: string) => invoke('plugin:ios-player|control', { action: 'collection', id, collectionRef })
export const syncIOSQueue = async (tracks: Track[], repeatMode: RepeatMode, shuffled: boolean, resumeThresholdSeconds: ResumeThreshold = 0, source?: QueueSource) => invoke('plugin:ios-player|queue', await nativeQueueEnvelope(tracks, repeatMode, shuffled, resumeThresholdSeconds, source))
export async function playIOSAudio(track: Track, url: string, position: number, volume: number, playing = true, collectionRef?: string, rate = 1, seamless = false, upgradeUrl?: string, automaticResume?: AutomaticResumePolicy, loudnessGainDb = 0) {
  await ready
  await invoke('plugin:ios-player|play', { loudnessEnabled: useLoudnessSettings.getState().enabled, loudnessRevision: useLoudnessSettings.getState().revision, loudnessGainDb, url, id: track.id, track: sourceTrack(track), position, volume, playing, collectionRef, rate, ...(seamless?{seamless:true}:{}), ...(upgradeUrl?{upgradeUrl}:{}), ...(automaticResume?{automaticResume}:{}) })
}
export const controlIOSAudio = (action: NativeControlAction, value = 0, settingsRevision?: number) => invoke('plugin:ios-player|control', { action, value, ...(settingsRevision !== undefined ? {settingsRevision} : {}) })
export const snapshotIOSAudio = async () => {
  const state = await invoke<IOSAudioState>('plugin:ios-player|snapshot')
  if (!order.accept(state)) return normalizeNativeSnapshot(order.latest!)
  lastEventAt = performance.now()
  clock.update(state, performance.now())
  return normalizeNativeSnapshot(state)
}
export const prepareIOSAudio = (track: Track) => invoke('plugin:ios-player|control', { action: 'prepare', id: track.id, track: sourceTrack(track) })
export function iosPlaybackClock() { return clock.position(performance.now()) }
