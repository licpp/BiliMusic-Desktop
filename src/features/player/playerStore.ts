import { withTrackTitle } from '../../domain/sourceTitle'
import { syncOHOSQueue } from './ohosAudio'
import { createOperationScope } from './operationScope'
import { prepareAudioSource } from './sourceSwitch'
import { advanceAccountEpoch } from '../../services/accountScope'
import { isMobile, isIOS, isAndroid, isOHOS } from '../../services/platform'
import { observeMobileAudio, setMobileCollection, prepareMobileAudio, playMobileAudio, controlMobileAudio, snapshotMobileAudio, mobilePlaybackClock } from './mobileAudio'
import { syncAndroidQueue } from './androidAudio'
import { iosListenerAge, playIOSAudio, restartIOSAudioObservation, syncIOSQueue, type IOSAudioState } from './iosAudio'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Track } from '../../domain/track'
import { getTrackPlaybackUrl, getTrackPlaybackPlan, inDesktopShell, recordPlayedTrack } from '../../services/desktopApi'
import { videoDetailFromTrack } from '../../services/mediaSources'
import { getVideoPages } from '../../services/videoPages'
import { getVideoParts } from '../../services/desktopApi'
import { toTrack } from '../../services/collectionTrack'
import { playbackPositionScope, readPlaybackPosition, usablePlaybackPosition, writePlaybackPosition } from './playbackPosition'
import { automaticResumePolicy, automaticResumePosition, isCollectionPlayback, normalizeResumeThreshold, type ResumeThreshold } from './resumePolicy'
import { preparePlaybackStart } from './playbackStart'
import { moveQueueTracks } from './queueGroups'
import { replaceSeasonEntry } from './seasonQueue'
import { commandErrorMessage, isConnectionError } from '../../services/userErrors'
import { demoTracks } from '../library/demoTracks'

export type PlaybackStatus = 'idle' | 'resolving' | 'buffering' | 'playing' | 'paused' | 'error'
export const playbackRates = [0.75, 1, 1.25, 1.5, 1.75, 2] as const
export type RepeatMode = 'off' | 'all' | 'one'
type SleepState = { deadline: number; duration: number; expired: boolean }
const noSleep = { deadline: 0, duration: 0, expired: false }
export type QueueSource = { creatorKeyword?: string; creatorMid?: number; creatorPage?: number; creatorTotal?: number; kind: 'video' | 'season'; title: string; collectionRef?: string }
type PlayerState = { queueSource?: QueueSource; queueFeedback?: { serial: number; title?: string }; sleep: SleepState; current: Track | null; queue: Track[]; status: PlaybackStatus; error: string | null; queueOpen: boolean; queueReversed: boolean; reverseQueue: () => void; progressSeconds: number; durationSeconds: number; volume: number; rate: number; resumeThresholdSeconds: ResumeThreshold; setResumeThreshold: (threshold: ResumeThreshold) => void; setRate: (rate: number) => Promise<void>; shuffled: boolean; repeatMode: RepeatMode; play: (track: Track, startAt?: number, refreshing?: boolean, checkpointAt?: number) => Promise<void>; playAll: (tracks: Track[]) => Promise<void>; playFromList: (tracks: Track[], trackId: string, source?: QueueSource, startAt?: number, resumeCheckpoint?: boolean) => Promise<void>; enqueue: (tracks: Track[]) => void; removeFromQueue: (id: string) => void; removeQueueRows: (ids: string[]) => void; moveQueueRows: (ids: string[], direction: -1 | 1, byVideo: boolean) => void; clearQueue: () => void; moveInQueue: (id: string, direction: -1 | 1) => void; toggle: () => Promise<void>; toggleQueue: () => void; next: (fromEnded?: boolean) => Promise<void>; previous: () => Promise<void>; seek: (seconds: number) => void; setVolume: (volume: number) => void; toggleShuffle: () => void; cycleRepeat: () => void; cyclePlaybackMode: () => void; updateTrack: (track: Track) => void }

let audio: HTMLAudioElement | null = null
const controlScope = createOperationScope()
let playRequest = 0
let requestedStartAt: number | undefined
let initialPositionPending = false
let sourceSwitchRequest = 0
let pendingDesktopUpgrade: { url: string; startAt: number; request: number; qualityIntent: number } | undefined
let desktopSeekRevision=0
let loadedTrackId: string | null = null
let queueIntent = 0
let loadedCollectionRef: string | undefined
let recoveryAttempted = false
let accountResetting = false
let accountReset: Promise<void> | undefined
let queueFeedbackSerial = 0
export const playbackIntent = () => queueIntent
let positionWrite = Promise.resolve()
let positionScope: Promise<string | undefined> = Promise.resolve(undefined)
let lastPositionWrite = 0
function savePosition(track: Track | null, position: number, duration: number) {
  if (!track || isMobile || initialPositionPending) return
  const scope = positionScope
  const observedAt = Date.now()
  const reference = loadedCollectionRef
  lastPositionWrite = observedAt
  positionWrite = positionWrite.then(async () => writePlaybackPosition(track.id, usablePlaybackPosition(position, duration), observedAt, await scope, reference))
}

function switchCollectionContext(reference?: string) {
  const state = usePlayerStore.getState()
  if (loadedCollectionRef === reference || !loadedTrackId || state.current?.id !== loadedTrackId) return
  if (isMobile) void setMobileCollection(loadedTrackId, reference).catch(() => undefined)
  else flushPosition(true)
  loadedCollectionRef = reference
  if (!isMobile && reference) flushPosition()
}

function recoverPlayback(error: unknown) {
  const state = usePlayerStore.getState()
  const message=typeof error === 'string' ? error : String((error as { message?: string })?.message || '')
  const transportFailure=isConnectionError(error) || /timed?\s*out|timeout|缓冲超时|缓冲停滞|音频准备超时|音源已更新|请联网|音频(?:加载|播放|流加载).*失败|音频无法播放|片段.*(?:变化|更新|中断|不完整)|\b(?:403|410)\b/i.test(message)
  if (!transportFailure || recoveryAttempted || !state.current || state.current.source.provider !== 'bilibili') return false
  recoveryAttempted = true
  const position = state.status === 'resolving' || initialPositionPending ? requestedStartAt :
    usablePlaybackPosition(state.progressSeconds, state.durationSeconds)
  void state.play(state.current, position, true)
  return true
}

export async function resolveSeasonEntry(entry: Track) {
  const bvid = entry.source.bvid
  const video = entry.source.aid
    ? videoDetailFromTrack(entry, await getVideoPages(bvid))
    : await getVideoParts(bvid)
  return video.parts.map(part => toTrack(video, part))
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
  const index = tracks.findIndex(track => track.source.bvid === selected.source.bvid)
  if (index < 0 || !parts.length) return tracks
  if (tracks[index].resolveParts) return replaceSeasonEntry(tracks, tracks[index].id, parts)
  if (tracks.some(track => track.id === selected.id)) return tracks
  const end = tracks.findIndex((track, at) => at > index && track.source.bvid !== selected.source.bvid)
  return [...tracks.slice(0, index), ...parts, ...(end < 0 ? [] : tracks.slice(end))]
}

export function adoptSeasonQueue(intent: number, selectedId: string, tracks: Track[], title: string, collectionRef?: string) {
  const state = usePlayerStore.getState()
  if (intent !== queueIntent || state.current?.id !== selectedId || !tracks.some(track => track.id === selectedId)) return
  usePlayerStore.setState({
    queue: tracks.map(track => track.id === selectedId ? { ...track, ...state.current!, partCount: track.partCount ?? state.current!.partCount } : track),
    queueReversed: false,
    queueSource: { kind: 'season', title, collectionRef },
    ...(state.queueFeedback ? { queueFeedback: { ...state.queueFeedback, title } } : {}),
  })
  switchCollectionContext(collectionRef)
}

async function ensurePlaying() {
  const state = usePlayerStore.getState()
  if (!state.current || state.status !== 'paused') return
  const valid = controlScope.begin('transport')
  usePlayerStore.setState({ status: 'playing', error: null })
  try {
    if (isMobile) await controlMobileAudio('resume')
    else if (inDesktopShell) await playerAudio().play()
  } catch (error) {
    if (!valid()) return
    const snapshot = isMobile ? await snapshotMobileAudio().catch(() => null) : null
    if (valid()) usePlayerStore.setState({ status: snapshot?.id === state.current.id ? snapshot.status as PlaybackStatus : 'paused', error: commandErrorMessage(error, '恢复播放失败') })
  }
}

export function resetPlayerForAccount() {
  if (accountReset) return accountReset
  accountResetting = true
  flushPosition()
  controlScope.invalidate()
  advanceAccountEpoch()
  ++queueIntent; ++playRequest;
  loadedTrackId = null
  initialPositionPending = false
  loadedCollectionRef = undefined
  nativeHistorySession = undefined
  recoveryAttempted = false
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }
  usePlayerStore.setState({ sleep: noSleep, current: null, queue: [], queueSource: undefined, queueFeedback: undefined, queueOpen: false, queueReversed: false, status: 'paused', progressSeconds: 0, durationSeconds: 0, rate: 1, error: null })
  flushPlayerSnapshot()
  accountReset = (async () => {
    // Stop native playback immediately, even if saving the old position fails.
    await Promise.all([
      positionWrite.catch(() => undefined),
      isMobile ? controlMobileAudio('stop').catch(() => undefined) : Promise.resolve(),
    ])
  })().finally(() => { accountResetting = false; accountReset = undefined })
  return accountReset
}
export function playbackClock() { if (isMobile) return mobilePlaybackClock(); return audio && loadedTrackId === usePlayerStore.getState().current?.id ? audio.currentTime : usePlayerStore.getState().progressSeconds }
let persistTimer: ReturnType<typeof setTimeout> | undefined
let pendingSnapshot: { key: string; value: string } | undefined
let snapshotQueue: Track[] | undefined
let snapshotCurrent: string | undefined
let urgentSnapshot = false
function flushPlayerSnapshot() {
  if (pendingSnapshot) { try { localStorage.setItem(pendingSnapshot.key, pendingSnapshot.value) } catch { /* Playback remains usable when storage is full. */ } pendingSnapshot = undefined }
}
const playerStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => { pendingSnapshot = { key, value }; if (urgentSnapshot) { urgentSnapshot = false; flushPlayerSnapshot(); return }; if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = undefined; flushPlayerSnapshot() }, 1000) },
  removeItem: (key: string) => localStorage.removeItem(key),
}
window.addEventListener('pagehide', () => { flushPosition(); flushPlayerSnapshot() })
window.addEventListener('blur', () => { flushPosition(); flushPlayerSnapshot() })
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) { flushPosition(); flushPlayerSnapshot() } })
function bindAudioEvents(element:HTMLAudioElement) {
  const on = (event:string,handler:()=>void) => element.addEventListener(event,()=>{if(audio===element)handler()})
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const clearStall = () => { clearTimeout(stallTimer); stallTimer = undefined }
  on('waiting', () => {
    if (stallTimer) return
    const id = loadedTrackId, position = audio?.currentTime || 0
    stallTimer = setTimeout(() => {
      stallTimer = undefined
      if (id && id === loadedTrackId && usePlayerStore.getState().status === 'buffering' &&
          (audio?.currentTime || 0) < position + .1) {
        if (!recoverPlayback('Network error')) usePlayerStore.setState({ status: 'error', error: '音频缓冲停滞，请重新播放' })
      }
    }, 12000)
  })
  for (const event of ['playing', 'pause', 'emptied', 'error', 'ended']) element.addEventListener(event, clearStall)
  on('waiting', () => usePlayerStore.setState({ status: 'buffering' }))
  on('playing', () => usePlayerStore.setState({ status: 'playing', error: null }))
  on('pause', () => { if (usePlayerStore.getState().status !== 'resolving') usePlayerStore.setState({ status: 'paused' }) })
  on('timeupdate', () => { usePlayerStore.setState({ progressSeconds: audio?.currentTime || 0 }); maybeUpgradeDesktop() })
  on('seeked', () => flushPosition(true))
  on('durationchange', () => { if (Number.isFinite(audio?.duration)) usePlayerStore.setState({ durationSeconds: audio?.duration || 0 }) })
  on('ended', () => void usePlayerStore.getState().next(true))
  on('error', () => {
    if (loadedTrackId !== usePlayerStore.getState().current?.id) return
    if (audio?.error?.code === 2 && recoverPlayback('Network error')) return
    usePlayerStore.setState({ status: 'error', error: '音频流加载失败，请重试' })
  })
}
function playerAudio() {
  if(!audio){audio=new Audio();audio.preload='metadata';audio.volume=usePlayerStore.getState().volume;bindAudioEvents(audio)}
  return audio
}

export const usePlayerStore = create<PlayerState>()(persist((set, get) => ({
  sleep: noSleep, current: inDesktopShell ? null : demoTracks[1], queue: inDesktopShell ? [] : demoTracks, status: 'paused', error: null, queueOpen: false, queueReversed: false, progressSeconds: 0, durationSeconds: inDesktopShell ? 0 : demoTracks[1].durationSeconds, volume: .7, rate: 1, resumeThresholdSeconds: 0, setResumeThreshold: value => set({ resumeThresholdSeconds: normalizeResumeThreshold(value) }), shuffled: false, repeatMode: 'off',
  play: async (track, startAt, refreshing = false, checkpointAt) => {
    if (accountResetting) return
    const previous = get()
    if (!refreshing && startAt === undefined && checkpointAt === undefined && track.id === previous.current?.id && loadedTrackId === track.id && previous.status !== 'error') { await ensurePlaying(); return }
    if (!refreshing) { recoveryAttempted = false; controlScope.invalidate() }
    const request = ++playRequest, qualityIntent = sourceSwitchRequest, seekRevision = desktopSeekRevision
    requestedStartAt = startAt
    pendingDesktopUpgrade = undefined
    ++queueIntent
    if (loadedTrackId === previous.current?.id && previous.current?.id !== track.id) {
      savePosition(previous.current, playbackClock(), previous.durationSeconds)
    }
    loadedTrackId = null
    initialPositionPending = false
    if (!isMobile) positionScope = playbackPositionScope()
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }
    set({ current: track, status: 'resolving', progressSeconds: 0, durationSeconds: track.durationSeconds, error: null, queueFeedback: undefined })
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
      const [recordedTrack, , resumeAt] = await Promise.all([
        recordPlayedTrack(track),
        isMobile ? prepareMobileAudio(track) : Promise.resolve(),
        startAt ?? checkpointAt ?? positionWrite.then(() => readPlaybackPosition(track.id)),
      ])
      if (request !== playRequest) return
      const storedTrack = { ...track, ...recordedTrack }
      const queue = get().queue.some((item) => item.id === storedTrack.id) ? get().queue.map((item) => item.id === storedTrack.id ? storedTrack : item) : [...get().queue, storedTrack]
      let resumePolicy = startAt === undefined ? automaticResumePolicy(get().resumeThresholdSeconds, storedTrack.durationSeconds, isCollectionPlayback(track, get().queue, get().queueSource)) : undefined
      let position = Number.isFinite(resumeAt) ? Math.max(0, resumeAt) : 0
      set({ current: storedTrack, queue, durationSeconds: storedTrack.durationSeconds, progressSeconds: desktopSeekRevision !== seekRevision ? get().progressSeconds : 0 })
      const [plan] = await Promise.all([
        getTrackPlaybackPlan(storedTrack, refreshing || previous.status === 'error'),
        isMobile ? ensureNativeReady().then(async () => {
          if (!isMobile || request !== playRequest) return
          const state = get()
          await syncNativeQueue(state.queue, state.repeatMode, state.shuffled, state.resumeThresholdSeconds, state.queueSource)
        }) : Promise.resolve(),
      ])
      if (request !== playRequest) return
      // Settings may change while the playback URL is resolving.
      if (resumePolicy) resumePolicy = automaticResumePolicy(get().resumeThresholdSeconds, storedTrack.durationSeconds, resumePolicy.collection)
      if (desktopSeekRevision !== seekRevision) { position = get().progressSeconds; resumePolicy = undefined }
      loadedCollectionRef = get().queueSource?.collectionRef
      if (isMobile) {
        loadedTrackId = storedTrack.id
        initialPositionPending = position > 0
        await playMobileAudio(storedTrack, plan.url, position, get().volume, true, loadedCollectionRef, get().rate, false, plan.upgradeUrl, resumePolicy)
        return
      }
      const element = playerAudio()
      initialPositionPending = position > 0
      element.src = plan.url; element.playbackRate = get().rate; loadedTrackId = storedTrack.id
      if (position > 0) position = await preparePlaybackStart(element, duration => desktopSeekRevision !== seekRevision ? get().progressSeconds : resumePolicy ? automaticResumePosition(position, duration, automaticResumePolicy(get().resumeThresholdSeconds, resumePolicy.durationSeconds, resumePolicy.collection)) : position, () => request === playRequest, Boolean(resumePolicy?.enabled && resumePolicy.thresholdSeconds > 0 && !(resumePolicy.durationSeconds > 0)))
      else element.currentTime = 0
      if (request !== playRequest) return
      initialPositionPending = false
      set({ progressSeconds: position, ...(Number.isFinite(element.duration) && element.duration > 0 ? { durationSeconds: element.duration } : {}) })
      if (plan.upgradeUrl) pendingDesktopUpgrade = { url: plan.upgradeUrl, startAt: position + .75, request, qualityIntent }
      await element.play()
    } catch (error) {
      if (request !== playRequest) return
      if (isMobile) {
        const action = get().sleep.deadline ? 'pause' : 'stop'
        await controlMobileAudio(action).catch(() => undefined)
        if (request !== playRequest) return
      }
      if (!recoverPlayback(error)) set({ status: 'error', error: commandErrorMessage(error, '暂时无法播放这首歌，请重试') })
    }
  },
  playFromList: async (tracks, trackId, queueSource, startAt, resumeCheckpoint = false) => {
    if (accountResetting) return
    const queue = uniqueTracks(tracks)
    const selected = queue.find(track => track.id === trackId)
    if (!selected) return
    ++queueIntent
    const { current, status, queue: oldQueue, queueSource: oldSource } = get()
    const keepPlaying = selected.id === current?.id && status !== 'error' && (loadedTrackId === current.id || status === 'resolving')
    const changed = oldSource?.collectionRef !== queueSource?.collectionRef || oldSource?.kind !== queueSource?.kind ||
      oldSource?.title !== queueSource?.title || oldQueue.length !== queue.length || oldQueue.some((track, index) => track.id !== queue[index].id)
    set({
      queue: current ? queue.map(item => item.id === current.id ? { ...item, ...current, resolveParts: item.resolveParts } : item) : queue,
      queueReversed: false, queueSource,
      ...(keepPlaying && changed ? { queueFeedback: { serial: ++queueFeedbackSerial, title: queueSource?.title } } : {}),
    })
    if (!keepPlaying || resumeCheckpoint) await get().play(selected, resumeCheckpoint ? undefined : startAt, false, resumeCheckpoint ? startAt : undefined)
    else {
      switchCollectionContext(queueSource?.collectionRef)
      if (startAt !== undefined && loadedTrackId === selected.id) {
        if (startAt === 0 || oldSource?.collectionRef !== queueSource?.collectionRef) get().seek(startAt)
      }
      if (status === 'paused') await ensurePlaying()
      if (selected.resolveParts) void prepareSeasonQueueEntry(selected).catch(() => undefined)
    }
  },
  playAll: async (tracks) => { if (tracks[0]) await get().playFromList(tracks, tracks[0].id) },
  enqueue: (tracks) => { ++queueIntent; set(({ queue }) => ({ queue: uniqueTracks([...queue, ...tracks]) })) },
  removeFromQueue: (id) => get().removeQueueRows([id]),
  removeQueueRows: (ids) => {
    ++queueIntent
    const removing = new Set(ids)
    set(({ queue }) => ({ queue: queue.filter(track => !removing.has(track.id)) }))
  },
  moveQueueRows: (ids, direction, byVideo) => {
    ++queueIntent
    set(({ queue }) => ({ queue: moveQueueTracks(queue, ids, direction, byVideo) }))
  },
  clearQueue: () => { ++queueIntent; switchCollectionContext(); set({ queue: [], queueReversed: false, queueSource: undefined }) },
  reverseQueue: () => { ++queueIntent; set(({ queue, queueReversed }) => ({ queue: [...queue].reverse(), queueReversed: !queueReversed })) },
  moveInQueue: (id, direction) => { ++queueIntent; set(({ queue }) => { const next = [...queue]; const index = next.findIndex((track) => track.id === id); const target = index + direction; if (index < 0 || target < 0 || target >= next.length) return {}; [next[index], next[target]] = [next[target], next[index]]; return { queue: next } }) },
  toggle: async () => {
    const { current, status } = get(); if (!current) return
    const valid = controlScope.begin('transport')
    const failed = (error: unknown) => { if (valid()) set({ error: commandErrorMessage(error, '无法控制播放，请重试') }) }
    // A newly opened player reads the same database checkpoint as selecting a
    // song. Only recovery of an interrupted attempt uses the live position.
    const resumeAt = () => status === 'error' ? initialPositionPending || loadedTrackId !== current.id ? requestedStartAt : Math.max(0, get().progressSeconds) : undefined
    if (!inDesktopShell) { set({ status: status === 'playing' ? 'paused' : 'playing' }); return }
    if (isMobile) {
      if (status === 'resolving') {
        ++playRequest
        loadedTrackId = null; initialPositionPending = false
        set({ status: 'paused' })
        await controlMobileAudio('pause').catch(failed)
        return
      }
      if (loadedTrackId === current.id && status !== 'error') {
        const pausing = status === 'playing' || status === 'buffering'
        set({ status: pausing ? 'paused' : 'playing' })
        try {
          await controlMobileAudio(pausing ? 'pause' : 'resume')
          if (valid() && pausing) window.dispatchEvent(new Event('bilimusic-data-changed'))
        }
        catch (error) {
          if (!valid()) return
          const snapshot = await snapshotMobileAudio().catch(() => null)
          if (!valid()) return
          set({ status: snapshot?.id === current.id ? snapshot.status as PlaybackStatus : status, error: commandErrorMessage(error, '无法控制播放，请重试') })
        }
        return
      }
      const nativeState = await snapshotMobileAudio().catch(() => ({} as IOSAudioState))
      if (!valid()) return
      if (!nativeState.id || nativeState.stopped) loadedTrackId = null
      if (nativeState.id === current.id && !nativeState.stopped && status !== 'error') {
        const pausing = nativeState.status === 'playing' || nativeState.status === 'buffering'
        set({ status: pausing ? 'paused' : 'playing' })
        await controlMobileAudio(pausing ? 'pause' : 'resume').catch(failed)
      } else await get().play(current, resumeAt())
      return
    }
    const element = playerAudio()
    if (status === 'resolving') { ++playRequest; loadedTrackId = null; initialPositionPending = false; element.pause(); set({ status: 'paused' }); return }
    if (status === 'playing' || status === 'buffering') element.pause()
    else if (loadedTrackId === current.id && element.src && status !== 'error') await element.play().catch(() => { if (valid()) set({ status: 'error', error: '恢复播放失败' }) })
    else await get().play(current, resumeAt())
  },
  toggleQueue: () => set(({ queueOpen }) => ({ queueOpen: !queueOpen })),
  next: async (fromEnded = false) => { const { current, queue, shuffled, repeatMode } = get(); if (fromEnded) { savePosition(current, 0, 0); loadedTrackId = null } if (fromEnded && repeatMode === 'one' && current) { await get().play(current, 0); return } if (!queue.length) { set({ status: 'paused' }); return } if (fromEnded && !shuffled && repeatMode === 'off' && current?.id === queue[queue.length - 1]?.id) { set({ status: 'paused' }); return } const index = current ? queue.findIndex((track) => track.id === current.id) : -1; const nextIndex = shuffled && queue.length > 1 ? randomOtherIndex(queue.length, index) : (index + 1) % queue.length; await get().play(queue[nextIndex], fromEnded && queue[nextIndex].id === current?.id ? 0 : undefined) },
  previous: async () => { const { current, queue, progressSeconds } = get(); if (progressSeconds > 4) { get().seek(0); return } if (!queue.length) return; const index = current ? queue.findIndex((track) => track.id === current.id) : 0; await get().play(queue[(index - 1 + queue.length) % queue.length]) },
  seek: (seconds) => {
    const valid = controlScope.begin('seek')
    desktopSeekRevision+=1; const target = Math.max(0, Math.min(seconds, get().durationSeconds || seconds)); if (isMobile) void controlMobileAudio('seek', target).catch(error => { if (valid()) nativeError(error) }); else if (audio && loadedTrackId === get().current?.id) audio.currentTime = target; set({ progressSeconds: target }) },
  setVolume: (volume) => { const valid = controlScope.begin('volume'); const normalized = Math.max(0, Math.min(1, volume)); if (isMobile) void controlMobileAudio('volume', normalized).catch(error => { if (valid()) nativeError(error) }); else playerAudio().volume = normalized; set({ volume: normalized }) },
  setRate: async rate => {
    if (!playbackRates.some(option => option === rate) || rate === get().rate) return
    const valid = controlScope.begin('rate')
    const previous = get().rate
    set({ rate })
    try {
      if (isMobile && loadedTrackId) await controlMobileAudio('rate', rate)
      else if (audio) audio.playbackRate = rate
    } catch {
      if (valid()) set({ rate: previous, error: '当前无法调整播放速度，请重试' })
    }
  },
  toggleShuffle: () => set(({ shuffled }) => ({ shuffled: !shuffled, repeatMode: 'all' })),
  cycleRepeat: () => set(({ repeatMode }) => ({ shuffled:false, repeatMode: repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off' })),
  cyclePlaybackMode: () => set(({ shuffled, repeatMode }) => shuffled ? { shuffled:false, repeatMode:'off' } : repeatMode === 'off' ? { shuffled:false, repeatMode:'all' } : repeatMode === 'all' ? { shuffled:false, repeatMode:'one' } : { shuffled:true, repeatMode:'all' }),
  updateTrack: (track) => set(({ current, queue }) => ({ current: current?.id === track.id ? track : current, queue: queue.map(item => item.id === track.id ? { ...item, ...track, resolveParts: item.resolveParts } : item) })),
}), {
  name: 'resonance-player-v1', storage: createJSONStorage(() => playerStorage),
  merge: (persisted, initial) => {
    const saved = persisted as Partial<PlayerState> & { autoResume?: boolean }
    const normalize = (track: Track) => withTrackTitle({ ...track, coverUrl: track.coverUrl?.replace(/^http:\/\//, 'https://') })
    const retiredCurrent = saved.current?.id.startsWith('local:')
    const { autoResume: legacyAutoResume, ...restored } = saved
    return {
      ...initial, ...restored,
      resumeThresholdSeconds: saved.resumeThresholdSeconds !== undefined ? normalizeResumeThreshold(saved.resumeThresholdSeconds) : legacyAutoResume === false ? null : initial.resumeThresholdSeconds,
      repeatMode: saved.shuffled ? 'all' : saved.repeatMode || initial.repeatMode,
      current: saved.current && !retiredCurrent ? normalize(saved.current) : initial.current,
      queue: Array.isArray(saved.queue) ? saved.queue.filter(track => !track.id.startsWith('local:')).map(normalize) : initial.queue,
      ...(retiredCurrent ? { progressSeconds: 0, durationSeconds: 0 } : {}),
    }
  },
  partialize: ({ current, queue, queueSource, queueReversed, progressSeconds, durationSeconds, volume, shuffled, repeatMode, resumeThresholdSeconds }) => {
    urgentSnapshot = queue !== snapshotQueue || current?.id !== snapshotCurrent
    snapshotQueue = queue; snapshotCurrent = current?.id
    return { current, queue, queueSource, queueReversed, progressSeconds, durationSeconds, volume, shuffled, repeatMode, resumeThresholdSeconds }
  },
}))

function flushPosition(notify = false) {
  const state = usePlayerStore.getState()
  if (state.current && loadedTrackId === state.current.id) {
    savePosition(state.current, playbackClock(), state.durationSeconds)
    if (notify && !isMobile) {
      void positionScope.then(scope => scope === undefined ? undefined : positionWrite.then(() => window.dispatchEvent(new Event('bilimusic-data-changed'))))
    }
  }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) flushPosition() })
usePlayerStore.subscribe((state, previous) => {
  if (state.current?.id !== previous.current?.id && typeof sessionStorage !== 'undefined') sessionStorage.removeItem('lyrics-subtitles-override')
  if (isMobile) return
  if (state.status === 'paused' && previous.status !== 'paused' && state.current?.id === previous.current?.id) flushPosition(true)
  else if (state.status === 'playing' && (previous.status !== 'playing' ||
    (state.progressSeconds !== previous.progressSeconds && Date.now() - lastPositionWrite >= 15_000))) flushPosition()
})

function uniqueTracks(tracks: Track[]) { return [...new Map(tracks.map((track) => [track.id, track])).values()] }

function randomOtherIndex(length: number, current: number) {
  const offset = 1 + Math.floor(Math.random() * (length - 1))
  return (Math.max(0, current) + offset) % length
}

function nativeError(error: unknown) { usePlayerStore.setState({ status: 'error', error: commandErrorMessage(error, '播放器暂时不可用，请重试') }) }
let nativeHistorySession: string | undefined
let nativeSession: string | undefined
let floatingStyleRevision=0
function onNativeState(state: Awaited<ReturnType<typeof snapshotMobileAudio>> & IOSAudioState) {
  if (accountResetting) return
  const session = state.engineInstanceId && state.sessionId ? `${state.engineInstanceId}:${state.sessionId}` : undefined
  if (session && session !== nativeSession) { controlScope.invalidate(); nativeSession = session }
  if (state.floatingLyricsEnabled !== undefined) window.dispatchEvent(new CustomEvent('bilimusic-native-floating',{detail:state.floatingLyricsEnabled}))
  if(state.floatingLyricsStyleRevision && state.floatingLyricsStyleRevision>floatingStyleRevision){floatingStyleRevision=state.floatingLyricsStyleRevision;window.dispatchEvent(new CustomEvent('bilimusic-floating-style',{detail:{fontSize:state.floatingLyricsFontSize,locked:state.floatingLyricsLocked}}))}
  if (state.sleepDeadline !== undefined) {
    const sleep = usePlayerStore.getState().sleep
    const next = { deadline: state.sleepDeadline, duration: state.sleepDuration ?? 0, expired: Boolean(state.sleepExpired) }
    if (sleep.deadline !== next.deadline || sleep.duration !== next.duration || sleep.expired !== next.expired) usePlayerStore.setState({ sleep: next })
  }
  if (isMobile && state.expandedEntries) {
    const current = usePlayerStore.getState()
    let queue = current.queue
    for (const [id, parts] of Object.entries(state.expandedEntries)) queue = replaceSeasonEntry(queue, id, parts)
    if (queue !== current.queue) usePlayerStore.setState({ queue })
  }
  if (isMobile && state.track?.resolveParts && state.track.source.cid <= 0 && state.status !== 'error') return
  if (isMobile && state.track && state.id !== usePlayerStore.getState().current?.id) {
    const current = usePlayerStore.getState()
    if (current.current && (current.status !== 'resolving' || loadedTrackId === current.current.id) && current.queue.some(track => track.id === state.id)) {
      ++queueIntent
      controlScope.invalidate()
      recoveryAttempted = false
      const track = state.track
      requestedStartAt = undefined
      initialPositionPending = state.status === 'buffering'
      usePlayerStore.setState({ current: track, queue: current.queue.map(item => item.id === track.id ? track : item), progressSeconds: 0 })
      window.dispatchEvent(new Event('bilimusic-data-changed'))
    }
  }
  if (state.action && state.id && state.id !== usePlayerStore.getState().current?.id) return
  if (state.action === 'resume') { void usePlayerStore.getState().toggle(); return }
  if (state.action === 'next') { void usePlayerStore.getState().next(); return }
  if (state.action === 'previous') { void usePlayerStore.getState().previous(); return }
  if (state.action === 'ended' && state.autonomousQueue) return
  if (state.action === 'ended') { void usePlayerStore.getState().next(true); return }
  if (!state.id) { loadedTrackId = null; if (usePlayerStore.getState().status !== 'resolving') usePlayerStore.setState({ status: 'paused' }); return }
  if (state.id !== usePlayerStore.getState().current?.id) return
  if (state.status === 'playing') initialPositionPending = false
  if (state.status === 'paused' && usePlayerStore.getState().status === 'resolving') ++playRequest
  loadedTrackId = state.stopped ? null : state.id
  if (state.status === 'error' && state.error && !state.recoveryAttempted && !document.hidden && recoverPlayback(state.error)) return
  if (!state.stopped && state.status === 'paused' && usePlayerStore.getState().status !== 'paused') {
    window.dispatchEvent(new Event('bilimusic-data-changed'))
  }
  if (!state.stopped && state.status === 'playing' && nativeHistorySession !== (session ?? state.id)) {
    nativeHistorySession = session ?? state.id
    window.dispatchEvent(new Event('bilimusic-recent-changed'))
  }
  usePlayerStore.setState({ status: state.stopped && state.status === 'buffering' ? 'resolving' : state.status || 'paused', progressSeconds: state.position || 0,
    ...(state.duration ? { durationSeconds: state.duration } : {}), error: state.error ? commandErrorMessage(state.error, '音频流加载失败，请重试') : null })
}
let nativeReady: Promise<void> | undefined
function ensureNativeReady() {
  if (!isMobile) return Promise.resolve()
  return nativeReady ??= observeMobileAudio(onNativeState)
    .then(async () => onNativeState(await snapshotMobileAudio()))
    .catch(error => { nativeReady = undefined; throw error })
}
void ensureNativeReady().catch(nativeError)
let reconciliationPending = false
let foregroundPending = false
async function reconcileMobilePlayback(rebind = false, foreground = false) {
  foregroundPending ||= foreground
  if (reconciliationPending) return
  reconciliationPending = true
  try {
    if (isIOS && rebind) await restartIOSAudioObservation()
    else await ensureNativeReady()
    onNativeState(await snapshotMobileAudio())
  } catch (error) {
    if (isIOS && !rebind) {
      try { await restartIOSAudioObservation(); onNativeState(await snapshotMobileAudio()); return } catch { /* report the original failure */ }
    }
    nativeError(error)
  } finally { reconciliationPending = false; if (foregroundPending) { foregroundPending = false; window.dispatchEvent(new Event('bilimusic-playback-reconciled')) } }
}
if (isMobile) {
  const resume = () => { if (!document.hidden) void reconcileMobilePlayback(isIOS && iosListenerAge() > 2_000, true) }
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('pageshow', resume)
  window.addEventListener('focus', resume)
}
let lastNativePollAt = 0
if (isMobile) window.setInterval(() => {
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

const syncNativeQueue = isOHOS ? syncOHOSQueue : isIOS ? syncIOSQueue : syncAndroidQueue
if (isMobile) usePlayerStore.subscribe((state, previous) => {
  if (state.queue !== previous.queue || state.repeatMode !== previous.repeatMode || state.shuffled !== previous.shuffled || state.resumeThresholdSeconds !== previous.resumeThresholdSeconds || state.queueSource !== previous.queueSource) {
    void ensureNativeReady().then(() => {
      const current = usePlayerStore.getState()
      return syncNativeQueue(current.queue, current.repeatMode, current.shuffled, current.resumeThresholdSeconds, current.queueSource)
    }).catch(error => console.warn('BiliMusic: queue update failed', error))
  }
})

// A recreated WebView must mirror its restored/adopted queue even before the
// user edits it. Read the native snapshot first to retain background advances.
if (isMobile) void ensureNativeReady().then(() => {
  const state = usePlayerStore.getState()
  return syncNativeQueue(state.queue, state.repeatMode, state.shuffled, state.resumeThresholdSeconds, state.queueSource)
}).catch(error => console.warn('BiliMusic: initial queue update failed', error))

// Resolve first; leave the current audio playing if a new quality is unavailable.
export async function reloadCurrentAudioSource() {
  const switchRequest=++sourceSwitchRequest
  pendingDesktopUpgrade=undefined
  const track=usePlayerStore.getState().current
  if (!track || loadedTrackId!==track.id) return
  const request=playRequest,seekRevision=desktopSeekRevision
  const valid=()=>request===playRequest&&seekRevision===desktopSeekRevision&&switchRequest===sourceSwitchRequest&&usePlayerStore.getState().current?.id===track.id
  const url=await getTrackPlaybackUrl(track,true,true)
  if(!valid())return
  if(isMobile){const state=usePlayerStore.getState();await playMobileAudio(track,url,playbackClock(),state.volume,state.status==='playing'||state.status==='buffering',loadedCollectionRef,state.rate,true);return}
  await switchDesktopSource(url,valid)
}

function maybeUpgradeDesktop() {
  const pending=pendingDesktopUpgrade
  if(!pending || !audio || usePlayerStore.getState().status!=='playing' || audio.currentTime<pending.startAt)return
  pendingDesktopUpgrade=undefined
  const seekRevision=desktopSeekRevision
  const valid=()=>pending.request===playRequest && pending.qualityIntent===sourceSwitchRequest && seekRevision===desktopSeekRevision
  if(valid())void switchDesktopSource(pending.url,valid).catch(()=>undefined)
}

async function switchDesktopSource(url:string, valid:()=>boolean) {
  const candidate=await prepareAudioSource(url,playbackClock,valid,usePlayerStore.getState().rate)
  try{
    if(!valid())return
    const state=usePlayerStore.getState(),playing=state.status==='playing'||state.status==='buffering'
    candidate.playbackRate=state.rate
    if(playing)await candidate.play()
    if(!valid())return
    // A user's pause during preparation always wins over the captured state.
    const latest=usePlayerStore.getState();if(latest.status!=='playing'&&latest.status!=='buffering')candidate.pause()
    const previous=audio;bindAudioEvents(candidate);audio=candidate
    previous?.pause();previous?.removeAttribute('src');previous?.load()
    candidate.volume=latest.volume;candidate.muted=false
    usePlayerStore.setState({status:candidate.paused?'paused':'playing',progressSeconds:candidate.currentTime,error:null})
  }finally{if(audio!==candidate){candidate.pause();candidate.removeAttribute('src');candidate.load()}}
}

export async function prepareForApplicationUpdate() {
  flushPosition()
  flushPlayerSnapshot()
  await positionWrite.catch(() => undefined)
}
