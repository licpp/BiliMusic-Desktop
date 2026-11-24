import { useLoudnessSettings } from '../../services/loudness'
import type { NativeControlAction } from './contracts'
import { normalizeNativeSnapshot } from './contracts'
import { createSnapshotOrder } from './snapshotOrder'
import { addPluginListener,invoke } from '@tauri-apps/api/core'
import type { Track } from '../../domain/track'
import { createNativeClock } from './nativeClock'
import type { AutomaticResumePolicy } from './resumePolicy'

import type { NativeAudioState as State, PlayerSnapshot } from './contracts'

function mediaMetadata(track: Track) {
  return {
    id: track.id, title: track.title, artist: track.artist || '歌手未知',
    album: track.album, coverUrl: track.coverUrl, durationSeconds: track.durationSeconds,
  }
}

export function createNativeAudio(plugin: string, bind?: (callback: (state: State) => void) => Promise<unknown>) {
  let ready: Promise<unknown> | undefined
  let consumer: (state: PlayerSnapshot) => void = () => undefined
  const clock = createNativeClock()
  const order = createSnapshotOrder()
  function observe(callback: (state: PlayerSnapshot) => void) {
    consumer = callback
    const receive = (state: State) => {
      // Commands are events, not clock samples. Older Android players send
      // action-only packets; comparing their absent revision with the latest
      // playback revision silently dropped notification/headset navigation.
      if (state.action) {
        if (!order.accept(state)) return
        consumer(normalizeNativeSnapshot(state))
        return
      }
      if (!order.accept(state)) return
      clock.update(state, performance.now())
      consumer(normalizeNativeSnapshot(state))
    }
    if (!ready) ready = (bind ? bind(receive) : addPluginListener<State>(plugin, 'state', receive)).catch((error) => { ready = undefined; throw error })
    return ready
  }
  async function play(track: Track, url: string, position: number, volume: number, playing = true, collectionRef?: string, rate = 1, seamless = false, upgradeUrl?: string, automaticResume?: AutomaticResumePolicy, loudnessGainDb = 0, diagnosticId?: string, accountSession?: string) {
    await ready
    await invoke(`plugin:${plugin}|play`, { ...mediaMetadata(track), ...(accountSession ? { accountSession } : {}), ...(diagnosticId ? { diagnosticId } : {}), loudnessEnabled: useLoudnessSettings.getState().enabled, loudnessRevision: useLoudnessSettings.getState().revision, loudnessGainDb, url, position, volume, playing, collectionRef, rate, ...(seamless?{seamless:true}:{}), ...(upgradeUrl?{upgradeUrl}:{}), ...(automaticResume?{automaticResume}:{}) })
  }
  const setCollection = (id: string, collectionRef?: string) => invoke(`plugin:${plugin}|control`, { action: 'collection', id, collectionRef })
  const control = (action: NativeControlAction, value = 0, settingsRevision?: number) => invoke(`plugin:${plugin}|control`, { action, value, ...(settingsRevision !== undefined ? {settingsRevision} : {}) })
  const snapshot = async () => {
    const observed = order.latest
    const state = await invoke<State>(`plugin:${plugin}|snapshot`)
    const serviceStopped = state.stopped && !state.engineInstanceId && !state.id && !state.action
    const accepted = serviceStopped ? order.retireIfCurrent(observed) : order.accept(state)
    if (!accepted) return normalizeNativeSnapshot(order.latest ?? { stopped: true })
    clock.update(state, performance.now())
    return normalizeNativeSnapshot(state)
  }
  function playbackClock() { return clock.position(performance.now()) }

  const prepare = (track: Track) => invoke(`plugin:${plugin}|control`, { action: 'prepare', ...mediaMetadata(track) })

  return { observe, play, setCollection, control, snapshot, playbackClock, prepare }
}
