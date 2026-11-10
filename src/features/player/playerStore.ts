import { advanceAccountEpoch } from '../../services/accountScope'
import { isMobile, isIOS } from '../../services/platform'
import { observeMobileAudio, prepareMobileAudio, playMobileAudio, controlMobileAudio, snapshotMobileAudio, mobilePlaybackClock } from './mobileAudio'
import { iosListenerAge, playIOSAudio, restartIOSAudioObservation, syncIOSQueue, type IOSAudioState } from './iosAudio'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Track } from '../../domain/track'
import { getTrackPlaybackUrl, inDesktopShell, recordPlayedTrack } from '../../services/desktopApi'
import { getVideoParts } from '../../services/desktopApi'
import { toTrack } from '../../services/collectionTrack'
import { playbackPositionScope, readPlaybackPosition, usablePlaybackPosition, writePlaybackPosition } from './playbackPosition'
import { replaceSeasonEntry } from './seasonQueue'
import { demoTracks } from '../library/demoTracks'

export type PlaybackStatus = 'idle' | 'resolving' | 'buffering' | 'playing' | 'paused' | 'error'
export type RepeatMode = 'off' | 'all' | 'one'
type SleepState = { deadline: number; duration: number; expired: boolean }
const noSleep = { deadline: 0, duration: 0, expired: false }
type PlayerState = { sleep: SleepState; current: Track | null; queue: Track[]; status: PlaybackStatus; error: string | null; queueOpen: boolean; queueReversed: boolean; reverseQueue: () => void; progressSeconds: number; durationSeconds: number; volume: number; shuffled: boolean; repeatMode: RepeatMode; play: (track: Track, startAt?: number) => Promise<void>; playAll: (tracks: Track[]) => Promise<void>; playFromList: (tracks: Track[], trackId: string) => Promise<void>; enqueue: (tracks: Track[]) => void; removeFromQueue: (id: string) => void; clearQueue: () => void; moveInQueue: (id: string, direction: -1 | 1) => void; toggle: () => Promise<void>; toggleQueue: () => void; next: (fromEnded?: boolean) => Promise<void>; previous: () => Promise<void>; seek: (seconds: number) => void; setVolume: (volume: number) => void; toggleShuffle: () => void; cycleRepeat: () => void; cyclePlaybackMode: () => void; updateTrack: (track: Track) => void }

let audio: HTMLAudioElement | null = null
let playRequest = 0
let loadedTrackId: string | null = null
let queueIntent = 0
export const playbackIntent = () => queueIntent
let positionWrite = Promise.resolve()
let positionScope: Promise<string | undefined> = Promise.resolve(undefined)
let lastPositionWrite = 0
function savePosition(track: Track | null, position: number, duration: number) {
  if (!track || isMobile) return
  const scope = positionScope
  const observedAt = Date.now()
  lastPositionWrite = observedAt
  positionWrite = positionWrite.then(async () => writePlaybackPosition(track.id, usablePlaybackPosition(position, duration), observedAt, await scope))
}

export function resolveSeasonEntry(entry: Track) {
  return getVideoParts(entry.source.bvid).then(video => video.parts.map(part => toTrack(video, part)))
}

export async function prepareSeasonQueueEntry(entry: Track) {
  const intent = playbackIntent()
  const parts = await resolveSeasonEntry(entry)
  if (parts.length && intent === playbackIntent()) {
    usePlayerStore.setState(({ queue }) => ({ queue: replaceSeasonEntry(queue, entry.id, parts) }))
  }
  return parts[0]
}

export function seasonPlaybackQueue(tracks: Track[], selected: Track, parts: Track[]) {
  const entry = tracks.find(track => track.source.bvid === selected.source.bvid)
  return entry ? replaceSeasonEntry(tracks, entry.id, parts) : tracks
}

export function adoptSeasonQueue(intent: number, selectedId: string, tracks: Track[]) {
  const state = usePlayerStore.getState()
  if (intent !== queueIntent || state.current?.id !== selectedId || !tracks.some(track => track.id === selectedId)) return
  usePlayerStore.setState({
    queue: tracks.map(track => track.id === selectedId ? state.current! : track),
    queueReversed: false,
  })
}

export async function resetPlayerForAccount() {
  advanceAccountEpoch()
  ++queueIntent; ++playRequest;
  loadedTrackId = null
  await positionWrite
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }
  if (isMobile) await controlMobileAudio('stop').catch(() => undefined)
  usePlayerStore.setState({ sleep: noSleep, current: null, queue: [], status: 'paused', progressSeconds: 0, durationSeconds: 0, error: null })
  flushPlayerSnapshot()
}
export function playbackClock() { if (isMobile) return mobilePlaybackClock(); return audio && loadedTrackId === usePlayerStore.getState().current?.id ? audio.currentTime : usePlayerStore.getState().progressSeconds }
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
window.addEventListener('pagehide', () => { flushPosition(); flushPlayerSnapshot() })
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
  sleep: noSleep, current: inDesktopShell ? null : demoTracks[1], queue: inDesktopShell ? [] : demoTracks, status: 'paused', error: null, queueOpen: false, queueReversed: false, progressSeconds: 0, durationSeconds: inDesktopShell ? 0 : demoTracks[1].durationSeconds, volume: .7, shuffled: false, repeatMode: 'off',
  play: async (track, startAt) => {
    const previous = get()
    if (startAt === undefined && track.id === previous.current?.id && loadedTrackId === track.id && previous.status !== 'error') return
    const request = ++playRequest
    ++queueIntent
    if (loadedTrackId === previous.current?.id && previous.current?.id !== track.id) {
      savePosition(previous.current, previous.progressSeconds, previous.durationSeconds)
    }
    loadedTrackId = null
    if (!isMobile) positionScope = playbackPositionScope()
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }
    set({ current: track, status: 'resolving', progressSeconds: 0, durationSeconds: track.durationSeconds, error: null })
    if (!inDesktopShell) { set({ status: 'playing' }); return }
    try {
      if (track.resolveParts) {
        if (isMobile && previous.current) await controlMobileAudio('pause').catch(() => undefined)
        const parts = await resolveSeasonEntry(track).catch(() => [])
        if (request !== playRequest) return
        if (parts.length) {
          set({ queue: replaceSeasonEntry(get().queue, track.id, parts) })
          track = parts[0]
          set({ current: track, durationSeconds: track.durationSeconds })
        } else if (track.source.cid <= 0) {
          throw new Error('无法读取合集中的这个视频')
        }
      }
      const [storedTrack, , resumeAt] = await Promise.all([
        recordPlayedTrack(track),
        isMobile ? prepareMobileAudio(track) : Promise.resolve(),
        startAt === undefined ? positionWrite.then(() => readPlaybackPosition(track.id)) : startAt,
      ])
      if (request !== playRequest) return
      const queue = get().queue.some((item) => item.id === storedTrack.id) ? get().queue.map((item) => item.id === storedTrack.id ? storedTrack : item) : [...get().queue, storedTrack]
      set({ current: storedTrack, queue, durationSeconds: storedTrack.durationSeconds })
      const position = startAt === undefined ? usablePlaybackPosition(resumeAt, storedTrack.durationSeconds) : Math.max(0, resumeAt)
      const [url] = await Promise.all([
        getTrackPlaybackUrl(storedTrack),
        isMobile ? nativeReady.then(async () => {
          if (!isIOS || request !== playRequest) return
          const state = get()
          await syncIOSQueue(state.queue, state.repeatMode, state.shuffled)
        }) : Promise.resolve(),
      ])
      if (request !== playRequest) return
      if (isMobile) {
        loadedTrackId = storedTrack.id
        await playMobileAudio(storedTrack, url, position, get().volume)
        return
      }
      const element = playerAudio(); element.src = url; element.currentTime = position; loadedTrackId = storedTrack.id; await element.play()
    } catch (error) {
      if (request !== playRequest) return
      if (isMobile) {
        const action = get().sleep.deadline ? 'pause' : 'stop'
        await controlMobileAudio(action).catch(() => undefined)
        if (request !== playRequest) return
      }
      const message = typeof error === 'string' && error.trim() ? error : error && typeof error === 'object' && 'message' in error ? String(error.message) : '无法解析播放地址'
      set({ status: 'error', error: message })
    }
  },
  playFromList: async (tracks, trackId) => {
    const queue = uniqueTracks(tracks)
    const selected = queue.find(track => track.id === trackId)
    if (!selected) return
    ++queueIntent
    const current = get().current
    const status = get().status
    set({ queue: current ? queue.map(item => item.id === current.id ? { ...item, ...current, resolveParts: item.resolveParts } : item) : queue, queueReversed: false })
    if (selected.id !== current?.id || status === 'error' || (loadedTrackId !== current.id && status !== 'resolving')) await get().play(selected)
    else if (selected.resolveParts) void prepareSeasonQueueEntry(selected).catch(() => undefined)
  },
  playAll: async (tracks) => { if (tracks[0]) await get().playFromList(tracks, tracks[0].id) },
  enqueue: (tracks) => { ++queueIntent; set(({ queue }) => ({ queue: uniqueTracks([...queue, ...tracks]) })) },
  removeFromQueue: (id) => { ++queueIntent; set(({ queue }) => ({ queue: queue.filter(track => track.id !== id) })) },
  clearQueue: () => { ++queueIntent; set({ queue: [], queueReversed: false }) },
  reverseQueue: () => { ++queueIntent; set(({ queue, queueReversed }) => ({ queue: [...queue].reverse(), queueReversed: !queueReversed })) },
  moveInQueue: (id, direction) => { ++queueIntent; set(({ queue }) => { const next = [...queue]; const index = next.findIndex((track) => track.id === id); const target = index + direction; if (index < 0 || target < 0 || target >= next.length) return {}; [next[index], next[target]] = [next[target], next[index]]; return { queue: next } }) },
  toggle: async () => {
    const { current, status } = get(); if (!current) return
    if (!inDesktopShell) { set({ status: status === 'playing' ? 'paused' : 'playing' }); return }
    if (isMobile) {
      if (status === 'resolving') { ++playRequest; await controlMobileAudio('pause'); set({ status: 'paused' }); return }
      if (loadedTrackId === current.id && status !== 'error') {
        const pausing = status === 'playing' || status === 'buffering'
        set({ status: pausing ? 'paused' : 'playing' })
        try { await controlMobileAudio(pausing ? 'pause' : 'resume') }
        catch (error) { set({ status, error: String(error) }) }
        return
      }
      const nativeState = await snapshotMobileAudio()
      if (!nativeState.id || nativeState.stopped) loadedTrackId = null
      if (nativeState.id === current.id && !nativeState.stopped && status !== 'error') {
        const pausing = nativeState.status === 'playing' || nativeState.status === 'buffering'
        set({ status: pausing ? 'paused' : 'playing' })
        await controlMobileAudio(pausing ? 'pause' : 'resume')
      } else await get().play(current, usablePlaybackPosition(get().progressSeconds, get().durationSeconds) || undefined)
      return
    }
    const element = playerAudio()
    if (status === 'resolving') { ++playRequest; element.pause(); set({ status: 'paused' }); return }
    if (status === 'playing' || status === 'buffering') element.pause()
    else if (loadedTrackId === current.id && element.src && status !== 'error') await element.play().catch(() => set({ status: 'error', error: '恢复播放失败' }))
    else await get().play(current, usablePlaybackPosition(get().progressSeconds, get().durationSeconds) || undefined)
  },
  toggleQueue: () => set(({ queueOpen }) => ({ queueOpen: !queueOpen })),
  next: async (fromEnded = false) => { const { current, queue, shuffled, repeatMode } = get(); if (fromEnded) { savePosition(current, 0, 0); loadedTrackId = null } if (fromEnded && repeatMode === 'one' && current) { await get().play(current, 0); return } if (!queue.length) { set({ status: 'paused' }); return } if (fromEnded && !shuffled && repeatMode === 'off' && current?.id === queue[queue.length - 1]?.id) { set({ status: 'paused' }); return } const index = current ? queue.findIndex((track) => track.id === current.id) : -1; const nextIndex = shuffled && queue.length > 1 ? randomOtherIndex(queue.length, index) : (index + 1) % queue.length; await get().play(queue[nextIndex], fromEnded && queue[nextIndex].id === current?.id ? 0 : undefined) },
  previous: async () => { const { current, queue, progressSeconds } = get(); if (progressSeconds > 4) { get().seek(0); return } if (!queue.length) return; const index = current ? queue.findIndex((track) => track.id === current.id) : 0; await get().play(queue[(index - 1 + queue.length) % queue.length]) },
  seek: (seconds) => { const target = Math.max(0, Math.min(seconds, get().durationSeconds || seconds)); if (isMobile) void controlMobileAudio('seek', target).catch(nativeError); else if (audio && loadedTrackId === get().current?.id) audio.currentTime = target; set({ progressSeconds: target }) },
  setVolume: (volume) => { const normalized = Math.max(0, Math.min(1, volume)); if (isMobile) void controlMobileAudio('volume', normalized).catch(nativeError); else playerAudio().volume = normalized; set({ volume: normalized }) },
  toggleShuffle: () => set(({ shuffled }) => ({ shuffled: !shuffled, repeatMode: 'all' })),
  cycleRepeat: () => set(({ repeatMode }) => ({ shuffled:false, repeatMode: repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off' })),
  cyclePlaybackMode: () => set(({ shuffled, repeatMode }) => shuffled ? { shuffled:false, repeatMode:'off' } : repeatMode === 'off' ? { shuffled:false, repeatMode:'all' } : repeatMode === 'all' ? { shuffled:false, repeatMode:'one' } : { shuffled:true, repeatMode:'all' }),
  updateTrack: (track) => set(({ current, queue }) => ({ current: current?.id === track.id ? track : current, queue: queue.map(item => item.id === track.id ? { ...track, resolveParts: item.resolveParts } : item) })),
}), { name: 'resonance-player-v1', storage: createJSONStorage(() => playerStorage), merge: (persisted, initial) => { const saved = persisted as Partial<PlayerState>; const normalize = (track: Track) => ({ ...track, coverUrl: track.coverUrl?.replace(/^http:\/\//, 'https://') }); return { ...initial, ...saved, repeatMode: saved.shuffled ? 'all' : saved.repeatMode || initial.repeatMode, current: saved.current ? normalize(saved.current) : initial.current, queue: Array.isArray(saved.queue) ? saved.queue.map(normalize) : initial.queue } }, partialize: ({ current, queue, queueReversed, progressSeconds, durationSeconds, volume, shuffled, repeatMode }) => ({ current, queue, queueReversed, progressSeconds, durationSeconds, volume, shuffled, repeatMode }) }))

function flushPosition() {
  const state = usePlayerStore.getState()
  if (state.current && loadedTrackId === state.current.id) savePosition(state.current, state.progressSeconds, state.durationSeconds)
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) flushPosition() })
usePlayerStore.subscribe((state, previous) => {
  if (state.current?.id !== previous.current?.id && typeof sessionStorage !== 'undefined') sessionStorage.removeItem('lyrics-subtitles-override')
  if (!isMobile && ((state.status === 'paused' && previous.status !== 'paused' && state.current?.id === previous.current?.id) ||
    (state.status === 'playing' && state.progressSeconds !== previous.progressSeconds && Date.now() - lastPositionWrite >= 15_000))) flushPosition()
})

function uniqueTracks(tracks: Track[]) { return [...new Map(tracks.map((track) => [track.id, track])).values()] }

function randomOtherIndex(length: number, current: number) {
  const offset = 1 + Math.floor(Math.random() * (length - 1))
  return (Math.max(0, current) + offset) % length
}

function nativeError(error: unknown) { usePlayerStore.setState({ status: 'error', error: String(error) }) }
function onNativeState(state: Awaited<ReturnType<typeof snapshotMobileAudio>> & IOSAudioState) {
  if (state.sleepDeadline !== undefined) {
    const sleep = usePlayerStore.getState().sleep
    const next = { deadline: state.sleepDeadline, duration: state.sleepDuration ?? 0, expired: Boolean(state.sleepExpired) }
    if (sleep.deadline !== next.deadline || sleep.duration !== next.duration || sleep.expired !== next.expired) usePlayerStore.setState({ sleep: next })
  }
  if (isIOS && state.expandedEntries) {
    const current = usePlayerStore.getState()
    let queue = current.queue
    for (const [id, parts] of Object.entries(state.expandedEntries)) queue = replaceSeasonEntry(queue, id, parts)
    if (queue !== current.queue) usePlayerStore.setState({ queue })
  }
  if (isIOS && state.track?.resolveParts && state.track.source.cid <= 0 && state.status !== 'error') return
  if (isIOS && state.track && state.id !== usePlayerStore.getState().current?.id) {
    const current = usePlayerStore.getState()
    if (current.current && (current.status !== 'resolving' || loadedTrackId === current.current.id) && current.queue.some(track => track.id === state.id)) {
      ++queueIntent
      const track = state.track
      usePlayerStore.setState({ current: track, queue: current.queue.map(item => item.id === track.id ? track : item), progressSeconds: 0 })
      window.dispatchEvent(new Event('bilimusic-data-changed'))
    }
  }
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
const nativeReady = isMobile ? observeMobileAudio(onNativeState).then(async () => onNativeState(await snapshotMobileAudio())) : Promise.resolve()
void nativeReady.catch(nativeError)
let reconciliationPending = false
async function reconcileMobilePlayback(rebind = false) {
  if (reconciliationPending) return
  reconciliationPending = true
  try {
    if (isIOS && rebind) await restartIOSAudioObservation()
    onNativeState(await snapshotMobileAudio())
  } catch (error) {
    if (isIOS && !rebind) {
      try { await restartIOSAudioObservation(); onNativeState(await snapshotMobileAudio()); return } catch { /* report the original failure */ }
    }
    nativeError(error)
  } finally { reconciliationPending = false }
}
if (isMobile) {
  const resume = () => { if (!document.hidden) void reconcileMobilePlayback(isIOS && iosListenerAge() > 2_000) }
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('pageshow', resume)
  window.addEventListener('focus', resume)
}
let lastNativePollAt = 0
if (isIOS) window.setInterval(() => {
  if (document.hidden) return
  const state = usePlayerStore.getState()
  if (state.status === 'playing') {
    const position = playbackClock()
    if (Number.isFinite(position) && Math.abs(position - state.progressSeconds) > .08) usePlayerStore.setState({ progressSeconds: position })
  }
  // Events may stop while the UI says paused/buffering too. Snapshot first;
  // repeated listener teardown can itself starve the channel of events.
  if (state.current && (state.status !== 'resolving' || loadedTrackId === state.current.id) && performance.now() - lastNativePollAt > 2_000) {
    lastNativePollAt = performance.now()
    void reconcileMobilePlayback()
  }
}, 250)

if (isIOS) usePlayerStore.subscribe((state, previous) => {
  if (state.queue !== previous.queue || state.repeatMode !== previous.repeatMode || state.shuffled !== previous.shuffled) {
    void nativeReady.then(() => syncIOSQueue(state.queue, state.repeatMode, state.shuffled)).catch(nativeError)
  }
})

// Resolve first; leave the current audio playing if a new quality is unavailable.
export async function reloadCurrentAudioSource() {
  const track=usePlayerStore.getState().current
  if (!track || loadedTrackId!==track.id) return
  const request=playRequest
  const url=await getTrackPlaybackUrl(track)
  if(request!==playRequest || usePlayerStore.getState().current?.id!==track.id)return
  const state=usePlayerStore.getState(),position=playbackClock(),playing=state.status==='playing'||state.status==='buffering'
  if(isIOS) await playIOSAudio(track,url,position,state.volume,playing)
  else if(isMobile) await playMobileAudio(track,url,position,state.volume,playing)
  else {const element=playerAudio();element.src=url;element.currentTime=position;if(playing)await element.play();else element.pause()}
}
