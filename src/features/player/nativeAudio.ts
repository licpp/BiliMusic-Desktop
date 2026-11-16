import type { NativeControlAction } from './contracts'
import { normalizeNativeSnapshot } from './contracts'
import { createSnapshotOrder } from './snapshotOrder'
import { addPluginListener,invoke } from '@tauri-apps/api/core'
import type { Track } from '../../domain/track'
import { createNativeClock } from './nativeClock'
import type { AutomaticResumePolicy } from './resumePolicy'

import type { NativeAudioState as State, PlayerSnapshot } from './contracts'

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
  async function play(track: Track, url: string, position: number, volume: number, playing = true, collectionRef?: string, rate = 1, seamless = false, upgradeUrl?: string, automaticResume?: AutomaticResumePolicy) {
    await ready
    await invoke(`plugin:${plugin}|play`, { url, id: track.id, title: track.title, artist: track.artist || '歌手未知', coverUrl: track.coverUrl, position, volume, playing, collectionRef, rate, ...(seamless?{seamless:true}:{}), ...(upgradeUrl?{upgradeUrl}:{}), ...(automaticResume?{automaticResume}:{}) })
  }
  const setCollection = (id: string, collectionRef?: string) => invoke(`plugin:${plugin}|control`, { action: 'collection', id, collectionRef })
  const control = (action: NativeControlAction, value = 0) => invoke(`plugin:${plugin}|control`, { action, value })
  const snapshot = async () => {
    const state = await invoke<State>(`plugin:${plugin}|snapshot`)
    if (!order.accept(state)) return normalizeNativeSnapshot(order.latest!)
    clock.update(state, performance.now())
    return normalizeNativeSnapshot(state)
  }
  function playbackClock() { return clock.position(performance.now()) }

  const prepare = (track: Track) => invoke(`plugin:${plugin}|control`, { action: 'prepare', id: track.id, title: track.title, artist: track.artist || '歌手未知', coverUrl: track.coverUrl })

  return { observe, play, setCollection, control, snapshot, playbackClock, prepare }
}
