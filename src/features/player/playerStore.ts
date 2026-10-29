import { advanceAccountEpoch } from '../../services/accountScope'
import { isAndroid } from '../../services/platform'
import { observeAndroidAudio, prepareAndroidAudio, playAndroidAudio, controlAndroidAudio, snapshotAndroidAudio, androidPlaybackClock } from './androidAudio'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Track } from '../../domain/track'
import { getTrackPlaybackUrl, inDesktopShell, recordPlayedTrack } from '../../services/desktopApi'
import { demoTracks } from '../library/demoTracks'

export type PlaybackStatus = 'idle' | 'resolving' | 'buffering' | 'playing' | 'paused' | 'error'
export type RepeatMode = 'off' | 'all' | 'one'
type PlayerState = { current: Track | null; queue: Track[]; status: PlaybackStatus; error: string | null; queueOpen: boolean; progressSeconds: number; durationSeconds: number; volume: number; shuffled: boolean; repeatMode: RepeatMode; play: (track: Track, startAt?: number) => Promise<void>; playAll: (tracks: Track[]) => Promise<void>; enqueue: (tracks: Track[]) => void; removeFromQueue: (id: string) => void; clearQueue: () => void; moveInQueue: (id: string, direction: -1 | 1) => void; toggle: () => Promise<void>; toggleQueue: () => void; next: (fromEnded?: boolean) => Promise<void>; previous: () => Promise<void>; seek: (seconds: number) => void; setVolume: (volume: number) => void; toggleShuffle: () => void; cycleRepeat: () => void; cyclePlaybackMode: () => void; updateTrack: (track: Track) => void }

let audio: HTMLAudioElement | null = null
let playRequest = 0
let loadedTrackId: string | null = null
export async function resetPlayerForAccount() {
  advanceAccountEpoch()
  ++playRequest; loadedTrackId = null
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }
  if (isAndroid) await controlAndroidAudio('stop').catch(() => undefined)
  usePlayerStore.setState({ current: null, queue: [], status: 'paused', progressSeconds: 0, durationSeconds: 0, error: null })
  flushPlayerSnapshot()
}
export function playbackClock() { if (isAndroid) return androidPlaybackClock(); return audio && loadedTrackId === usePlayerStore.getState().current?.id ? audio.currentTime : usePlayerStore.getState().progressSeconds }
let persistTimer: ReturnType<typeof setTimeout> | undefined
let pendingSnapshot: { key: string; value: string } | undefined
function flushPlayerSnapshot() {
  if (pendingSnapshot) { try { localStorage.setItem(pendingSnapshot.key, pendingSnapshot.value) } catch { /* Playback remains usable when storage is full. */ } pendingSnapshot = undefined }
}
const playerStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => { pendingSnapshot = { key, value }; if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = undefined; flushPlayerSnapshot() }, 1000) },
  removeItem: (key: string) => localStorage.removeItem(key),
}
window.addEventListener('pagehide', flushPlayerSnapshot)
function playerAudio() {
  if (audio) return audio
  audio = new Audio(); audio.preload = 'metadata'; audio.volume = usePlayerStore.getState().volume
  audio.addEventListener('waiting', () => usePlayerStore.setState({ status: 'buffering' }))
  audio.addEventListener('playing', () => usePlayerStore.setState({ status: 'playing', error: null }))
  audio.addEventListener('pause', () => { if (usePlayerStore.getState().status !== 'resolving') usePlayerStore.setState({ status: 'paused' }) })
  audio.addEventListener('timeupdate', () => usePlayerStore.setState({ progressSeconds: audio?.currentTime || 0 }))
  audio.addEventListener('durationchange', () => { if (Number.isFinite(audio?.duration)) usePlayerStore.setState({ durationSeconds: audio?.duration || 0 }) })
  audio.addEventListener('ended', () => void usePlayerStore.getState().next(true))
  audio.addEventListener('error', () => { if (loadedTrackId === usePlayerStore.getState().current?.id) usePlayerStore.setState({ status: 'error', error: '音频流加载失败，请重新播放' }) })
  return audio
}

export const usePlayerStore = create<PlayerState>()(persist((set, get) => ({
  current: inDesktopShell ? null : demoTracks[1], queue: inDesktopShell ? [] : demoTracks, status: 'paused', error: null, queueOpen: false, progressSeconds: 0, durationSeconds: inDesktopShell ? 0 : demoTracks[1].durationSeconds, volume: .7, shuffled: false, repeatMode: 'off',
  play: async (track, startAt = 0) => {
    const request = ++playRequest
    loadedTrackId = null
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }
    set({ current: track, status: 'resolving', progressSeconds: 0, durationSeconds: track.durationSeconds, error: null })
    if (!inDesktopShell) { set({ status: 'playing' }); return }
    try {
      if (isAndroid) { await prepareAndroidAudio(track); if (request !== playRequest) return }
      const storedTrack = await recordPlayedTrack(track)
      if (request !== playRequest) return
      const queue = get().queue.some((item) => item.id === storedTrack.id) ? get().queue.map((item) => item.id === storedTrack.id ? storedTrack : item) : [...get().queue, storedTrack]
      set({ current: storedTrack, queue, durationSeconds: storedTrack.durationSeconds })
      const url = await getTrackPlaybackUrl(storedTrack)
      if (request !== playRequest) return
      if (isAndroid) {
        await nativeReady
        if (request !== playRequest) return
        loadedTrackId = storedTrack.id
        await playAndroidAudio(storedTrack, url, Math.max(0, startAt), get().volume)
        return
      }
      const element = playerAudio(); element.src = url; element.currentTime = Math.max(0, startAt); loadedTrackId = storedTrack.id; await element.play()
    } catch (error) {
      if (request !== playRequest) return
      if (isAndroid) { await controlAndroidAudio('stop').catch(() => undefined); if (request !== playRequest) return }
      const message = typeof error === 'string' && error.trim() ? error : error && typeof error === 'object' && 'message' in error ? String(error.message) : '无法解析播放地址'
      set({ status: 'error', error: message })
    }
  },
  playAll: async (tracks) => { if (!tracks.length) return; set({ queue: uniqueTracks(tracks) }); await get().play(tracks[0]) },
  enqueue: (tracks) => set(({ queue }) => ({ queue: uniqueTracks([...queue, ...tracks]) })),
  removeFromQueue: (id) => set(({ queue }) => ({ queue: queue.filter((track) => track.id !== id) })),
  clearQueue: () => set({ queue: [] }),
  moveInQueue: (id, direction) => set(({ queue }) => { const next = [...queue]; const index = next.findIndex((track) => track.id === id); const target = index + direction; if (index < 0 || target < 0 || target >= next.length) return {}; [next[index], next[target]] = [next[target], next[index]]; return { queue: next } }),
  toggle: async () => {
    const { current, status } = get(); if (!current) return
    if (!inDesktopShell) { set({ status: status === 'playing' ? 'paused' : 'playing' }); return }
    if (isAndroid) {
      const nativeState = await snapshotAndroidAudio()
      if (!nativeState.id || nativeState.stopped) loadedTrackId = null
      if (status === 'resolving') { ++playRequest; await controlAndroidAudio('stop'); set({ status: 'paused' }); return }
      if (loadedTrackId === current.id && status !== 'error') {
        await controlAndroidAudio(status === 'playing' || status === 'buffering' ? 'pause' : 'resume')
      } else await get().play(current, get().progressSeconds)
      return
    }
    const element = playerAudio()
    if (status === 'resolving') { ++playRequest; element.pause(); set({ status: 'paused' }); return }
    if (status === 'playing' || status === 'buffering') element.pause()
    else if (loadedTrackId === current.id && element.src && status !== 'error') await element.play().catch(() => set({ status: 'error', error: '恢复播放失败' }))
    else await get().play(current, get().progressSeconds)
  },
  toggleQueue: () => set(({ queueOpen }) => ({ queueOpen: !queueOpen })),
  next: async (fromEnded = false) => { const { current, queue, shuffled, repeatMode } = get(); if (fromEnded && repeatMode === 'one' && current) { await get().play(current); return } if (!queue.length) { set({ status: 'paused' }); return } if (fromEnded && !shuffled && repeatMode === 'off' && current?.id === queue[queue.length - 1]?.id) { set({ status: 'paused' }); return } const index = current ? queue.findIndex((track) => track.id === current.id) : -1; const nextIndex = shuffled && queue.length > 1 ? randomOtherIndex(queue.length, index) : (index + 1) % queue.length; await get().play(queue[nextIndex]) },
  previous: async () => { const { current, queue, progressSeconds } = get(); if (progressSeconds > 4) { get().seek(0); return } if (!queue.length) return; const index = current ? queue.findIndex((track) => track.id === current.id) : 0; await get().play(queue[(index - 1 + queue.length) % queue.length]) },
  seek: (seconds) => { const target = Math.max(0, Math.min(seconds, get().durationSeconds || seconds)); if (isAndroid) void controlAndroidAudio('seek', target).catch(nativeError); else if (audio && loadedTrackId === get().current?.id) audio.currentTime = target; set({ progressSeconds: target }) },
  setVolume: (volume) => { const normalized = Math.max(0, Math.min(1, volume)); if (isAndroid) void controlAndroidAudio('volume', normalized).catch(nativeError); else playerAudio().volume = normalized; set({ volume: normalized }) },
  toggleShuffle: () => set(({ shuffled }) => ({ shuffled: !shuffled, repeatMode: 'all' })),
  cycleRepeat: () => set(({ repeatMode }) => ({ shuffled:false, repeatMode: repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off' })),
  cyclePlaybackMode: () => set(({ shuffled, repeatMode }) => shuffled ? { shuffled:false, repeatMode:'off' } : repeatMode === 'off' ? { shuffled:false, repeatMode:'all' } : repeatMode === 'all' ? { shuffled:false, repeatMode:'one' } : { shuffled:true, repeatMode:'all' }),
  updateTrack: (track) => set(({ current, queue }) => ({ current: current?.id === track.id ? track : current, queue: queue.map((item) => item.id === track.id ? track : item) })),
}), { name: 'resonance-player-v1', storage: createJSONStorage(() => playerStorage), merge: (persisted, initial) => { const saved = persisted as Partial<PlayerState>; const normalize = (track: Track) => ({ ...track, coverUrl: track.coverUrl?.replace(/^http:\/\//, 'https://') }); return { ...initial, ...saved, repeatMode: saved.shuffled ? 'all' : saved.repeatMode || initial.repeatMode, current: saved.current ? normalize(saved.current) : initial.current, queue: Array.isArray(saved.queue) ? saved.queue.map(normalize) : initial.queue } }, partialize: ({ current, queue, progressSeconds, durationSeconds, volume, shuffled, repeatMode }) => ({ current, queue, progressSeconds, durationSeconds, volume, shuffled, repeatMode }) }))

function uniqueTracks(tracks: Track[]) { return [...new Map(tracks.map((track) => [track.id, track])).values()] }

function randomOtherIndex(length: number, current: number) {
  const offset = 1 + Math.floor(Math.random() * (length - 1))
  return (Math.max(0, current) + offset) % length
}

function nativeError(error: unknown) { usePlayerStore.setState({ status: 'error', error: String(error) }) }
function onNativeState(state: Awaited<ReturnType<typeof snapshotAndroidAudio>>) {
  if (state.action === 'resume') { void usePlayerStore.getState().toggle(); return }
  if (state.action === 'next') { void usePlayerStore.getState().next(); return }
  if (state.action === 'previous') { void usePlayerStore.getState().previous(); return }
  if (state.action === 'ended') { void usePlayerStore.getState().next(true); return }
  if (!state.id) { loadedTrackId = null; if (usePlayerStore.getState().status !== 'resolving') usePlayerStore.setState({ status: 'paused' }); return }
  if (state.id !== usePlayerStore.getState().current?.id) return
  if (state.status === 'paused' && usePlayerStore.getState().status === 'resolving') ++playRequest
  loadedTrackId = state.stopped ? null : state.id
  usePlayerStore.setState({ status: state.stopped && state.status === 'buffering' ? 'resolving' : state.status || 'paused', progressSeconds: state.position || 0,
    ...(state.duration ? { durationSeconds: state.duration } : {}), error: state.error || null })
}
const nativeReady = isAndroid ? observeAndroidAudio(onNativeState).then(async () => onNativeState(await snapshotAndroidAudio())) : Promise.resolve()
void nativeReady.catch(nativeError)
if (isAndroid) document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void snapshotAndroidAudio().then(onNativeState).catch(nativeError)
})
