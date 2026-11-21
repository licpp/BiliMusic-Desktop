import { listVisibilityOrigins, entryAllowed, orderedQueueTarget, visibleCheckpoint, packQueueBase,unpackQueueBase,type VisibilityOrigin } from '../../domain/contentVisibility'
import { ensureVisibility, useContentVisibility } from '../../services/contentVisibility'
import { ShuffleDeck, type ShuffleState } from '../../domain/shuffle'
import { indexOfflineTracks, isOfflineVideoRow, offlineEntries, useOfflinePlayback, waitForOfflineLibrary } from './offlinePlayback'
import { useLoudnessSettings } from '../../services/loudness'
import { createOutputGain, outputVolume, safeGainDb } from './outputGain'
import { withTrackTitle } from '../../domain/sourceTitle'
import { sourceTrack } from '../../domain/importedPresentation'
import { syncOHOSQueue } from './ohosAudio'
import { createOperationScope } from './operationScope'
import { alignAudioSource, prepareAudioSource } from './sourceSwitch'
import { accountEpoch, advanceAccountEpoch } from '../../services/accountScope'
import { isMobile, isIOS, isAndroid, isOHOS } from '../../services/platform'
import { observeMobileAudio, setMobileCollection, prepareMobileAudio, playMobileAudio, controlMobileAudio, snapshotMobileAudio, mobilePlaybackClock } from './mobileAudio'
import { syncAndroidQueue } from './androidAudio'
import { iosListenerAge, playIOSAudio, restartIOSAudioObservation, syncIOSQueue, type IOSAudioState } from './iosAudio'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Track } from '../../domain/track'
import { getTrackPlaybackPlan, inDesktopShell, recordPlayedTrack } from '../../services/desktopApi'
import { videoDetailFromTrack } from '../../services/mediaSources'
import { getVideoPages } from '../../services/videoPages'
import { getVideoParts } from '../../services/desktopApi'
import { toTrack } from '../../services/collectionTrack'
import { playbackPositionScope, readPlaybackPosition, usablePlaybackPosition, writePlaybackPosition } from './playbackPosition'
import { automaticResumePolicy, automaticResumePosition, isCollectionPlayback, normalizeResumeThreshold, type ResumeThreshold } from './resumePolicy'
import { preparePlaybackStart } from './playbackStart'
import { moveQueueTracks } from './queueGroups'
import { replaceSeasonEntry } from './seasonQueue'
import { isConnectionError } from '../../services/userErrors'
import { playbackIssue, type PlaybackIssue } from './playbackIssue'
import { demoTracks } from '../library/demoTracks'
import { createDesktopSleepTimer, noSleep, type SleepState } from './desktopSleepTimer'

export type PlaybackStatus = 'idle' | 'resolving' | 'buffering' | 'playing' | 'paused' | 'error'
export const playbackRates = [0.75, 1, 1.25, 1.5, 1.75, 2] as const
export type RepeatMode = 'off' | 'all' | 'one'
export type QueueSource = { offlineOnly?: boolean; visibilityManaged?: boolean; entryOrder?:string[]; entryOrigins?: Record<string, VisibilityOrigin[]>; creatorKeyword?: string; creatorMid?: number; creatorPage?: number; creatorTotal?: number; kind: 'video' | 'season'; title: string; collectionRef?: string }
type PlayerState = { queueBase?: Track[]; queueOrigins?: Record<string,VisibilityOrigin[]>; shuffleState?: ShuffleState; queueSource?: QueueSource; queueFeedback?: { serial: number; title?: string }; sleep: SleepState; current: Track | null; queue: Track[]; status: PlaybackStatus; error: PlaybackIssue | null; queueOpen: boolean; queueReversed: boolean; reverseQueue: () => void; progressSeconds: number; durationSeconds: number; volume: number; rate: number; resumeThresholdSeconds: ResumeThreshold; setResumeThreshold: (threshold: ResumeThreshold) => void; setRate: (rate: number) => Promise<void>; shuffled: boolean; repeatMode: RepeatMode; play: (track: Track, startAt?: number, refreshing?: boolean, checkpointAt?: number, originPlayback?: boolean) => Promise<void>; playAll: (tracks: Track[]) => Promise<void>; playFromList: (tracks: Track[], trackId: string, source?: QueueSource, startAt?: number, resumeCheckpoint?: boolean) => Promise<void>; enqueue: (tracks: Track[]) => void; removeFromQueue: (id: string) => void; removeQueueRows: (ids: string[]) => void; moveQueueRows: (ids: string[], direction: -1 | 1, byVideo: boolean) => void; clearQueue: () => void; moveInQueue: (id: string, direction: -1 | 1) => void; toggle: () => Promise<void>; toggleQueue: () => void; next: (fromEnded?: boolean) => Promise<void>; previous: () => Promise<void>; seek: (seconds: number) => void; setVolume: (volume: number) => void; toggleShuffle: () => void; cycleRepeat: () => void; cyclePlaybackMode: () => void; updateTrack: (track: Track) => void }

let shuffleDeck = new ShuffleDeck()
const shuffleItems = (tracks: Track[]) => tracks.map(track => ({ id:track.id, artist:track.artist ?? '', bvid:track.source.bvid }))
let nativeAutonomousQueue = false
let nativeQueuePending: Promise<unknown> = Promise.resolve()
let audio: HTMLAudioElement | null = null
let trackGainDb = 0
const desktopGain = createOutputGain()
let gainTimer: ReturnType<typeof setTimeout> | undefined
function applyDesktopOutput(smooth = false) {
  clearTimeout(gainTimer)
  desktopGain.set(useLoudnessSettings.getState().enabled ? trackGainDb : 0, smooth)
  const element = audio
  const tick = () => {
    if (!element || element !== audio) return
    element.volume = outputVolume(usePlayerStore.getState().volume, desktopGain.current())
    if (desktopGain.active()) gainTimer = setTimeout(tick, 20)
  }
  tick()
}
export async function applyLoudnessSetting() {
  const setting = useLoudnessSettings.getState()
  if (isMobile) await controlMobileAudio('loudness', setting.enabled ? 1 : 0, setting.revision)
  else applyDesktopOutput(true)
}
const controlScope = createOperationScope()
let playRequest = 0
let sleepPauseRevision = 0
let requestedStartAt: number | undefined
let initialPositionPending = false
let sourceSwitchRequest = 0
let pendingDesktopUpgrade: { url: string; startAt: number; request: number; qualityIntent: number } | undefined
let desktopSeekRevision=0
let unloadedDesktopSeek: { trackId: string; seconds: number } | undefined
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
  if (useOfflinePlayback.getState().offline) {
    const epoch = accountEpoch()
    await waitForOfflineLibrary()
    if (epoch !== accountEpoch()) return []
    if (useOfflinePlayback.getState().offline) return offlineEntries(entry)
  }
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
    const state=usePlayerStore.getState(),origins=state.queueOrigins?.[entry.id]??['']
    usePlayerStore.setState({queueBase:replaceSeasonEntry(state.queueBase??state.queue,entry.id,parts),queueOrigins:{...state.queueOrigins,...Object.fromEntries(parts.map(part=>[part.id,origins]))}})
    reprojectVisibility()
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

export function adoptSeasonQueue(intent: number, selectedId: string, tracks: Track[], title: string, collectionRef?: string, visibilityManaged?: boolean) {
  const state = usePlayerStore.getState()
  if (intent !== queueIntent || state.current?.id !== selectedId || !tracks.some(track => track.id === selectedId)) return
  usePlayerStore.setState({
    queueBase:tracks,
    queueOrigins:Object.fromEntries(tracks.map(track=>[track.id,listVisibilityOrigins(track,{collectionRef,visibilityManaged})])),
    queue: tracks.map(track => track.id === selectedId ? { ...track, ...state.current!, partCount: track.partCount ?? state.current!.partCount } : track),
    queueReversed: false,
    queueSource: { kind: 'season', title, collectionRef, visibilityManaged },
    ...(state.queueFeedback ? { queueFeedback: { ...state.queueFeedback, title } } : {}),
  })
  reprojectVisibility()
  switchCollectionContext(collectionRef)
}

async function ensurePlaying() {
  const state = usePlayerStore.getState()
  if (!state.current || state.status !== 'paused') return
  if (!isMobile) desktopSleep.dismiss()
  const valid = controlScope.begin('transport')
  usePlayerStore.setState({ status: 'playing', error: null })
  try {
    if (isMobile) await controlMobileAudio('resume')
    else if (inDesktopShell) await playerAudio().play()
  } catch (error) {
    if (!valid()) return
    const snapshot = isMobile ? await snapshotMobileAudio().catch(() => null) : null
    if (valid()) usePlayerStore.setState({ status: snapshot?.id === state.current.id ? snapshot.status as PlaybackStatus : 'paused', error: playbackIssue('audio-control', error, '恢复播放失败') })
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
  unloadedDesktopSeek = undefined
  initialPositionPending = false
  loadedCollectionRef = undefined
  nativeHistorySession = undefined
  recoveryAttempted = false
  if (!isMobile) desktopSleep.cancel()
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }
  usePlayerStore.setState({ shuffleState:undefined, sleep: noSleep, current: null, queue: [],queueBase:[],queueOrigins:{}, queueSource: undefined, queueFeedback: undefined, queueOpen: false, queueReversed: false, status: 'paused', progressSeconds: 0, durationSeconds: 0, rate: 1, error: null })
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
        if (!recoverPlayback('Network error')) usePlayerStore.setState({ status: 'error', error: playbackIssue('audio-buffer', null, '音频缓冲停滞，请重新播放', 'audio_stalled') })
      }
    }, 12000)
  })
  for (const event of ['playing', 'pause', 'emptied', 'error', 'ended']) element.addEventListener(event, clearStall)
  on('waiting', () => usePlayerStore.setState({ status: 'buffering' }))
  on('playing', () => usePlayerStore.setState({ status: 'playing', error: null }))
  on('pause', () => { if (usePlayerStore.getState().status !== 'resolving') usePlayerStore.setState({ status: 'paused' }) })
  on('timeupdate', () => { usePlayerStore.setState({ progressSeconds: audio?.currentTime || 0 }); if (!desktopSleep.check()) maybeUpgradeDesktop() })
  on('seeked', () => flushPosition(true))
  on('durationchange', () => { if (Number.isFinite(audio?.duration)) usePlayerStore.setState({ durationSeconds: audio?.duration || 0 }) })
  on('ended', () => void usePlayerStore.getState().next(true))
  on('error', () => {
    if (loadedTrackId !== usePlayerStore.getState().current?.id) return
    if (audio?.error?.code === 2 && recoverPlayback('Network error')) return
    const mediaCode = audio?.error?.code
    usePlayerStore.setState({ status: 'error', error: playbackIssue(mediaCode === 3 ? 'audio-decode' : 'audio-playback',
      null, mediaCode === 3 ? '音频解码失败，请尝试更换音质' : '音频流加载失败，请重试', `html_media:${mediaCode}`) })
  })
}
function playerAudio() {
  if(!audio){audio=new Audio();audio.preload='metadata';audio.volume=outputVolume(usePlayerStore.getState().volume, useLoudnessSettings.getState().enabled ? trackGainDb : 0);bindAudioEvents(audio)}
  return audio
}

export const usePlayerStore = create<PlayerState>()(persist((set, get) => ({
  sleep: noSleep, current: inDesktopShell ? null : demoTracks[1], queue: inDesktopShell ? [] : demoTracks, status: 'paused', error: null, queueOpen: false, queueReversed: false, progressSeconds: 0, durationSeconds: inDesktopShell ? 0 : demoTracks[1].durationSeconds, volume: isMobile ? 1 : .7, rate: 1, resumeThresholdSeconds: 0, setResumeThreshold: value => set({ resumeThresholdSeconds: normalizeResumeThreshold(value) }), shuffled: false, repeatMode: 'off',
  play: async (track, startAt, refreshing = false, checkpointAt, originPlayback = false) => {
    track = withTrackTitle(track)
    if (accountResetting) return
    if (!isMobile && desktopSleep.check()) return
    const visibilityEpoch=accountEpoch(), sleepRevision = sleepPauseRevision
    if(!useContentVisibility.getState().session) await ensureVisibility()
    if (accountResetting || visibilityEpoch!==accountEpoch() || sleepRevision !== sleepPauseRevision) return
    const offlineRequest = playRequest
    if (useOfflinePlayback.getState().offline) {
      await waitForOfflineLibrary()
      if (visibilityEpoch !== accountEpoch() || offlineRequest !== playRequest || sleepRevision !== sleepPauseRevision) return
      const local = offlineEntries(track).find(part => entryAllowed(part, queueTrackOrigins(get(), track), useContentVisibility.getState().rules))
      if (!local) return
      track = local
    }
    if (!originPlayback && !refreshing) set(state=>({queueOrigins:{...state.queueOrigins,[track.id]:['']}}))
    const eligible = (candidate:Track) => entryAllowed(candidate, queueTrackOrigins(get(), candidate), useContentVisibility.getState().rules)
    if (!refreshing && !eligible(track)) { await get().next(); return }
    const previous = get()
    if (!isMobile && previous.sleep.expired) desktopSleep.dismiss()
    if (!isMobile && !refreshing && startAt === undefined && checkpointAt === undefined && unloadedDesktopSeek?.trackId === track.id) {
      startAt = unloadedDesktopSeek.seconds
    }
    unloadedDesktopSeek = undefined
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
    let stage: 'audio-source' | 'audio-start' = 'audio-source'
    try {
      if (track.resolveParts) {
        if (isMobile && previous.current) await controlMobileAudio('pause').catch(() => undefined)
        const parts = await resolveSeasonEntry(track)
        if (request !== playRequest) return
        if (parts.length) {
          const origins = get().queueOrigins?.[track.id] ?? ['']
          const queueOrigins = {...get().queueOrigins,...Object.fromEntries(parts.map(part=>[part.id,origins]))}
          const queueBase = replaceSeasonEntry(get().queueBase ?? get().queue,track.id,parts)
          const visible = parts.filter(part=>entryAllowed(part,origins,useContentVisibility.getState().rules))
          set({queueOrigins,queueBase,queue:replaceSeasonEntry(get().queue,track.id,visible,true)})
          if (!visible.length) { await get().next(); return }
          track = visible[0]
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
      const base = get().queueBase ?? queue
      const offline = useOfflinePlayback.getState().offline
      const representedByVideo = offline && base.some(item => isOfflineVideoRow(item) && item.source.bvid === storedTrack.source.bvid)
      const updatedBase = base.map(item => item.id === storedTrack.id && !(offline && isOfflineVideoRow(item)) ? storedTrack : item)
      const queueBase = uniqueTracks(representedByVideo ? updatedBase : [...updatedBase, storedTrack])
      set({ current: storedTrack, queue, queueBase, durationSeconds: storedTrack.durationSeconds, progressSeconds: desktopSeekRevision !== seekRevision ? get().progressSeconds : 0 })
      const [plan] = await Promise.all([
        getTrackPlaybackPlan(storedTrack, refreshing || previous.status === 'error', false, useOfflinePlayback.getState().offline),
        isMobile ? ensureNativeReady().then(async () => {
          if (!isMobile || request !== playRequest) return
          const state = get()
          await syncNativeQueue(state.queue, state.repeatMode, state.shuffled, state.resumeThresholdSeconds, state.queueSource)
        }) : Promise.resolve(),
      ])
      if (request !== playRequest) return
      if (!refreshing && !eligible(storedTrack)) { reprojectVisibility(); await get().next(); return }
      // Settings may change while the playback URL is resolving.
      if (resumePolicy) resumePolicy = automaticResumePolicy(get().resumeThresholdSeconds, storedTrack.durationSeconds, resumePolicy.collection)
      if (desktopSeekRevision !== seekRevision) { position = get().progressSeconds; resumePolicy = undefined }
      loadedCollectionRef = get().queueSource?.collectionRef
      stage = 'audio-start'
      if (isMobile) {
        loadedTrackId = storedTrack.id
        initialPositionPending = position > 0
        await playMobileAudio(storedTrack, plan.url, position, get().volume, true, loadedCollectionRef, get().rate, false, plan.upgradeUrl, resumePolicy, plan.loudnessGainDb)
        return
      }
      const element = playerAudio()
      initialPositionPending = position > 0
      trackGainDb = safeGainDb(plan.loudnessGainDb); applyDesktopOutput()
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
      if (useOfflinePlayback.getState().offline && typeof error === 'object' && error !== null &&
          'code' in error && error.code === 'offline_unavailable') {
        useOfflinePlayback.setState(state => ({
          library: state.library ? indexOfflineTracks([...state.library.byId.values()].filter(item => item.id !== track.id)) : null,
        }))
        await get().next(true)
        return
      }
      if (isMobile) {
        const action = get().sleep.deadline ? 'pause' : 'stop'
        await controlMobileAudio(action).catch(() => undefined)
        if (request !== playRequest) return
      }
      if (!recoverPlayback(error)) set({ status: 'error', error: playbackIssue(stage, error, '暂时无法播放这首歌，请重试') })
    }
  },
  playFromList: async (tracks, trackId, queueSource, startAt, resumeCheckpoint = false) => {
    if (accountResetting) return
    if (!isMobile && desktopSleep.check()) return
    const visibilityEpoch=accountEpoch(), sleepRevision = sleepPauseRevision
    if(!useContentVisibility.getState().session) await ensureVisibility()
    if (accountResetting || visibilityEpoch!==accountEpoch() || sleepRevision !== sleepPauseRevision) return
    const offlineIntent = queueIntent
    if (useOfflinePlayback.getState().offline) {
      await waitForOfflineLibrary()
      if (visibilityEpoch !== accountEpoch() || sleepRevision !== sleepPauseRevision || offlineIntent !== queueIntent) return
    }
    const queueBase = uniqueTracks(tracks)
    const origins = (track:Track) => listVisibilityOrigins(track, queueSource)
    const queueOrigins = Object.fromEntries(queueBase.map(track=>[track.id,origins(track)]))
    const rules = useContentVisibility.getState().rules
    const queue = projectQueue(queueBase, queueOrigins, rules)
    const allowed = (track: Track) => offlineEntries(track).filter(part => entryAllowed(part, origins(track), rules))
    const exactLocal = useOfflinePlayback.getState().offline ? queue.find(track => track.id === trackId) : undefined
    const entry = queueBase.find(track => track.id === trackId)
    if (!entry && !exactLocal) return
    const choice = entry && visibleCheckpoint(queueBase, trackId, track => allowed(track).length > 0).track
    const selected = exactLocal ?? (choice && allowed(choice)[0])
    if (!selected) return
    // A rule can arrive between preparing a resume command and replacing the queue.
    // The replacement song must never inherit the hidden checkpoint's timestamp.
    if (selected.id !== trackId) { startAt=0; resumeCheckpoint=false }
    ++queueIntent
    const { current, status, queue: oldQueue, queueSource: oldSource } = get()
    const keepPlaying = selected.id === current?.id && status !== 'error' && (loadedTrackId === current.id || status === 'resolving')
    const changed = oldSource?.collectionRef !== queueSource?.collectionRef || oldSource?.kind !== queueSource?.kind ||
      oldSource?.title !== queueSource?.title || oldQueue.length !== queue.length || oldQueue.some((track, index) => track.id !== queue[index].id)
    set({
      queue: current ? queue.map(item => item.id === current.id ? { ...item, ...current, resolveParts: item.resolveParts } : item) : queue,
      queueReversed: false, queueSource, queueBase, queueOrigins,
      ...(keepPlaying && changed ? { queueFeedback: { serial: ++queueFeedbackSerial, title: queueSource?.title } } : {}),
    })
    if (!keepPlaying || resumeCheckpoint) await get().play(selected, resumeCheckpoint ? undefined : startAt, false, resumeCheckpoint ? startAt : undefined,true)
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
  enqueue: (tracks) => {
    ++queueIntent
    set(state => {
      const queueBase = uniqueTracks([...(state.queueBase ?? state.queue), ...tracks])
      const queueOrigins = {...state.queueOrigins, ...Object.fromEntries(tracks.map(track => [track.id, ['']]))}
      return { queue: projectQueue(queueBase, queueOrigins, useContentVisibility.getState().rules), queueBase, queueOrigins }
    })
  },
  removeFromQueue: (id) => get().removeQueueRows([id]),
  removeQueueRows: (ids) => {
    ++queueIntent
    const removing = new Set(ids)
    set(state=>({queue:state.queue.filter(track=>!removing.has(track.id)),queueBase:(state.queueBase??state.queue).filter(track=>!removing.has(track.id))}))
  },
  moveQueueRows: (ids, direction, byVideo) => {
    ++queueIntent
    set(state=>{const queue=moveQueueTracks(state.queue,ids,direction,byVideo);return {queue,queueBase:reorderVisibleBase(state.queueBase??state.queue,queue)}})
  },
  clearQueue: () => { ++queueIntent; switchCollectionContext(); set({ queue: [], queueBase:[],queueOrigins:{},queueReversed: false, queueSource: undefined }) },
  reverseQueue: () => { ++queueIntent; set(state=>({queue:[...state.queue].reverse(),queueBase:[...(state.queueBase??state.queue)].reverse(),queueReversed:!state.queueReversed})) },
  moveInQueue: (id, direction) => { ++queueIntent; set(state => { const next = [...state.queue]; const index = next.findIndex((track) => track.id === id); const target = index + direction; if (index < 0 || target < 0 || target >= next.length) return {}; [next[index], next[target]] = [next[target], next[index]]; return { queue: next,queueBase:reorderVisibleBase(state.queueBase??state.queue,next) } }) },
  toggle: async () => {
    if (!isMobile && desktopSleep.check()) return
    const { current, status } = get(); if (!current) return
    if (!isMobile && (status === 'paused' || status === 'error')) desktopSleep.dismiss()
    const valid = controlScope.begin('transport')
    const failed = (error: unknown) => { if (valid()) set({ error: playbackIssue('audio-control', error, '无法控制播放，请重试') }) }
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
          set({ status: snapshot?.id === current.id ? snapshot.status as PlaybackStatus : status, error: playbackIssue('audio-control', error, '无法控制播放，请重试') })
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
    else if (loadedTrackId === current.id && element.src && status !== 'error') await element.play().catch(() => { if (valid()) set({ status: 'error', error: playbackIssue('audio-control', null, '恢复播放失败') }) })
    else await get().play(current, resumeAt())
  },
  toggleQueue: () => set(({ queueOpen }) => ({ queueOpen: !queueOpen })),
  next: async (fromEnded = false) => {
    if (accountResetting) return
    if (!isMobile && (desktopSleep.check() || fromEnded && get().sleep.expired)) return
    if (isMobile && nativeAutonomousQueue && !fromEnded) { await nativeTransport('next'); return }
    const { current, queue, shuffled, repeatMode } = get()
    if (fromEnded) { savePosition(current, 0, 0); loadedTrackId = null }
    if (fromEnded && repeatMode === 'one' && current && queue.some(t=>t.id===current.id)) { await get().play(current, 0,false,undefined,true); return }
    if (!queue.length) { set({ status:'paused' }); return }
    if (fromEnded && !shuffled && repeatMode === 'off' && current?.id === queue[queue.length-1]?.id) { set({ status:'paused' }); return }
    const id = shuffled ? shuffleDeck.target(shuffleItems(queue), current?.id ?? '', 1) : orderedQueueTarget(queueEntryOrder(get().queueBase??queue),queue.map(t=>t.id),current?.id??'',1,!fromEnded || repeatMode==='all')
    const track = queue.find(item => item.id === id)
    if (shuffled) set({ shuffleState:shuffleDeck.snapshot() })
    if (track) await get().play(track, fromEnded && track.id === current?.id ? 0 : undefined,false,undefined,true)
    else if(fromEnded)set({status:'paused'})
  },
  previous: async () => {
    if (accountResetting) return
    if (isMobile && nativeAutonomousQueue) { await nativeTransport('previous'); return }
    const { current, queue, progressSeconds, shuffled } = get()
    if (progressSeconds > 4) { get().seek(0); return }
    if (!queue.length) return
    const id = shuffled ? shuffleDeck.target(shuffleItems(queue),current?.id ?? '',-1) : orderedQueueTarget(queueEntryOrder(get().queueBase??queue),queue.map(t=>t.id),current?.id??'',-1,true)
    if (shuffled) set({ shuffleState:shuffleDeck.snapshot() })
    const track = queue.find(item => item.id === id)
    if (track) await get().play(track,undefined,false,undefined,true)
  },
  seek: (seconds) => {
    const valid = controlScope.begin('seek')
    const state = get()
    desktopSeekRevision += 1
    const target = Math.max(0, Math.min(seconds, state.durationSeconds || seconds))
    if (isMobile) void controlMobileAudio('seek', target).catch(error => { if (valid()) nativeError(error) })
    else if (audio && loadedTrackId === state.current?.id) audio.currentTime = target
    else if (state.current && state.status !== 'resolving') unloadedDesktopSeek = { trackId: state.current.id, seconds: target }
    set({ progressSeconds: target })
  },
  setVolume: (volume) => { const valid = controlScope.begin('volume'); const normalized = Math.max(0, Math.min(1, volume)); if (isMobile) void controlMobileAudio('volume', normalized).catch(error => { if (valid()) nativeError(error) }); else { playerAudio(); set({ volume: normalized }); applyDesktopOutput(); return }; set({ volume: normalized }) },
  setRate: async rate => {
    if (!playbackRates.some(option => option === rate) || rate === get().rate) return
    const valid = controlScope.begin('rate')
    const previous = get().rate
    set({ rate })
    try {
      if (isMobile && loadedTrackId) await controlMobileAudio('rate', rate)
      else if (audio) audio.playbackRate = rate
    } catch {
      if (valid()) set({ rate: previous, error: playbackIssue('audio-control', null, '当前无法调整播放速度，请重试') })
    }
  },
  toggleShuffle: () => set(({ shuffled }) => ({ shuffled: !shuffled, repeatMode: 'all' })),
  cycleRepeat: () => set(({ repeatMode }) => ({ shuffled:false, repeatMode: repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off' })),
  cyclePlaybackMode: () => set(({ shuffled, repeatMode }) => shuffled ? { shuffled:false, repeatMode:'off' } : repeatMode === 'off' ? { shuffled:false, repeatMode:'all' } : repeatMode === 'all' ? { shuffled:false, repeatMode:'one' } : { shuffled:true, repeatMode:'all' }),
  updateTrack: (track) => set(({ current, queue,queueBase }) => {
    const update = (item:Track) => item.id === track.id ? withTrackTitle({ ...sourceTrack(item), ...sourceTrack(track), importedEntry:item.importedEntry, resolveParts:item.resolveParts }) : item
    return { queueBase:queueBase?.map(update), current:current ? update(current) : null, queue:queue.map(update) }
  }),
}), {
  name: 'resonance-player-v1', storage: createJSONStorage(() => playerStorage),
  version: 2,
  migrate: (persisted, version) => {
    const saved = persisted as PlayerState
    const oldDefault = isAndroid ? version < 1 : isMobile && version < 2
    return oldDefault && saved.volume === .7 ? { ...saved, volume: 1 } : saved
  },
  merge: (persisted, initial) => {
    const saved = persisted as Partial<PlayerState> & { autoResume?: boolean;queueOrder?:string[];hiddenQueueTracks?:Track[] }
    shuffleDeck = new ShuffleDeck(Math.random, saved.shuffleState)
    const normalize = (track: Track) => withTrackTitle({ ...track, coverUrl: track.coverUrl?.replace(/^http:\/\//, 'https://') })
    const retiredCurrent = saved.current?.id.startsWith('local:')
    const { autoResume: legacyAutoResume, queueOrder,hiddenQueueTracks,...restored } = saved
    const queue=Array.isArray(saved.queue)?saved.queue.filter(track=>!track.id.startsWith('local:')).map(normalize):initial.queue
    const queueBase=Array.isArray(saved.queueBase)?saved.queueBase.filter(track=>!track.id.startsWith('local:')).map(normalize):unpackQueueBase(queue,queueOrder,hiddenQueueTracks?.map(normalize))
    return {
      ...initial, ...restored,
      resumeThresholdSeconds: saved.resumeThresholdSeconds !== undefined ? normalizeResumeThreshold(saved.resumeThresholdSeconds) : legacyAutoResume === false ? null : initial.resumeThresholdSeconds,
      repeatMode: saved.shuffled ? 'all' : saved.repeatMode || initial.repeatMode,
      current: saved.current && !retiredCurrent ? normalize(saved.current) : initial.current,
      queue,queueBase,
      queueOrigins:saved.queueOrigins ?? Object.fromEntries(queueBase.map(track=>[track.id,listVisibilityOrigins(track,saved.queueSource)])),
      ...(retiredCurrent ? { progressSeconds: 0, durationSeconds: 0 } : {}),
    }
  },
  partialize: ({ queueBase,queueOrigins,shuffleState, current, queue, queueSource, queueReversed, progressSeconds, durationSeconds, volume, shuffled, repeatMode, resumeThresholdSeconds }) => {
    urgentSnapshot = queue !== snapshotQueue || current?.id !== snapshotCurrent
    snapshotQueue = queue; snapshotCurrent = current?.id
    const base = queueBase ?? queue
    const baseIds = new Set(base.map(track => track.id))
    const storedQueue = useOfflinePlayback.getState().offline ? queue.filter(track => baseIds.has(track.id)) : queue
    return { ...packQueueBase(storedQueue,base),queueOrigins,shuffleState:isMobile ? undefined : shuffleState, current, queue: storedQueue, queueSource, queueReversed, progressSeconds, durationSeconds, volume, shuffled, repeatMode, resumeThresholdSeconds }
  },
}))

const desktopSleep = createDesktopSleepTimer(
  () => usePlayerStore.getState().sleep,
  sleep => usePlayerStore.setState({ sleep }),
  () => {
    ++sleepPauseRevision
    ++playRequest
    pendingDesktopUpgrade = undefined
    const state = usePlayerStore.getState()
    if (state.status === 'resolving' || initialPositionPending) {
      loadedTrackId = null
      initialPositionPending = false
    }
    if (state.status === 'playing' || state.status === 'buffering' || state.status === 'resolving') {
      controlScope.invalidate()
      audio?.pause()
      usePlayerStore.setState({ status: 'paused' })
    }
  },
)

if (!isMobile) {
  window.addEventListener('focus', () => desktopSleep.check())
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => desktopSleep.check())
}
export async function controlDesktopSleep(action: 'sleepStart' | 'sleepCancel' | 'sleepDismiss' | 'sleepRepeat', seconds = 0) {
  if (action === 'sleepCancel') desktopSleep.cancel()
  else if (action === 'sleepDismiss') desktopSleep.dismiss()
  else if (action === 'sleepStart') desktopSleep.start(seconds)
  else {
    const state = usePlayerStore.getState()
    if (!state.sleep.expired || !state.sleep.duration) return
    desktopSleep.start(state.sleep.duration)
    if (state.current && state.status === 'paused') await state.toggle()
  }
}

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
  if (state.shuffled !== previous.shuffled || !state.queue.length) shuffleDeck.reset()
  if ((!isMobile || !nativeAutonomousQueue) && state.shuffled && (state.queue !== previous.queue || state.current?.id !== previous.current?.id || !previous.shuffled)) {
    shuffleDeck.observe(shuffleItems(state.queue),state.current?.id ?? '')
    usePlayerStore.setState({ shuffleState:shuffleDeck.snapshot() })
  }
  if (isMobile) return
  if (state.status === 'paused' && previous.status !== 'paused' && state.current?.id === previous.current?.id) flushPosition(true)
  else if (state.status === 'playing' && (previous.status !== 'playing' ||
    (state.progressSeconds !== previous.progressSeconds && Date.now() - lastPositionWrite >= 15_000))) flushPosition()
})

function uniqueTracks(tracks: Track[]) { return [...new Map(tracks.map((track) => [track.id, track])).values()] }


async function nativeTransport(action:'next'|'previous') {
  const valid=controlScope.begin('transport')
  try {
    // Mode/queue mirrors must settle before native chooses from its shuffle deck.
    let pending:Promise<unknown>
    do { pending=nativeQueuePending;await pending } while(valid() && pending!==nativeQueuePending)
    if(valid()) await controlMobileAudio(action)
  } catch(error) { if(valid()) nativeError(error) }
}
function nativeError(error: unknown) { usePlayerStore.setState({ status: 'error', error: playbackIssue('audio-control', error, '播放器暂时不可用，请重试') }) }
let nativeHistorySession: string | undefined
let nativeSession: string | undefined
let nativeFailureKey: string | undefined
let nativeLyricsScope: { id: string; session: string } | undefined
export const nativeLyricPlaybackSession = (id: string) => nativeLyricsScope?.id === id ? nativeLyricsScope.session : undefined
let floatingStyleRevision=0
function onNativeState(state: Awaited<ReturnType<typeof snapshotMobileAudio>> & IOSAudioState) {
  if (accountResetting) return
  nativeAutonomousQueue = state.capabilities?.autonomousQueue ?? state.autonomousQueue ?? false
  const session = state.engineInstanceId && state.sessionId ? `${state.engineInstanceId}:${state.sessionId}` : undefined
  if (!state.action) nativeLyricsScope = session && state.id ? { id: state.id, session } : undefined
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
    let queueBase = current.queueBase ?? current.queue
    let queueOrigins = {...current.queueOrigins}
    for (const [id,parts] of Object.entries(state.expandedEntries)) {
      const origins = queueOrigins[id] ?? ['']
      queueOrigins = {...queueOrigins,...Object.fromEntries(parts.map(part=>[part.id,origins]))}
      queueBase = replaceSeasonEntry(queueBase,id,parts,true)
    }
    if (queueBase !== current.queueBase) {usePlayerStore.setState({queueBase,queueOrigins});reprojectVisibility()}
  }
  if (isMobile && state.track?.resolveParts && state.track.source.cid <= 0 && state.status !== 'error') return
  if (isMobile && state.track && state.id !== usePlayerStore.getState().current?.id) {
    const current = usePlayerStore.getState()
    if (current.current && (current.status !== 'resolving' || loadedTrackId === current.current.id) && current.queue.some(track => track.id === state.id)) {
      ++queueIntent
      controlScope.invalidate()
      recoveryAttempted = false
      const queued = current.queue.find(item => item.id === state.id)
      const track = withTrackTitle({ ...state.track, ...(queued?.titleOverridden ? queued : {}), importedEntry: queued?.importedEntry })
      requestedStartAt = undefined
      initialPositionPending = state.status === 'buffering'
      usePlayerStore.setState({ current: track, queue: current.queue.map(item => item.id === track.id ? track : item), progressSeconds: 0 })
      window.dispatchEvent(new Event('bilimusic-data-changed'))
    }
  }
  if (state.action && state.id && state.id !== usePlayerStore.getState().current?.id) return
  if (state.action === 'resume') { void usePlayerStore.getState().toggle(); return }
  if (nativeAutonomousQueue && ['next','previous','ended'].includes(state.action ?? '')) return
  if (state.action === 'next') { void usePlayerStore.getState().next(); return }
  if (state.action === 'previous') { void usePlayerStore.getState().previous(); return }
  if (state.action === 'ended' && state.autonomousQueue) return
  if (state.action === 'ended') { void usePlayerStore.getState().next(true); return }
  if (!state.id) { nativeFailureKey = undefined; loadedTrackId = null; if (usePlayerStore.getState().status !== 'resolving') usePlayerStore.setState({ status: 'paused' }); return }
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
  let error: PlaybackIssue | null | undefined = null
  if (state.error) {
    const key = JSON.stringify([accountEpoch(), session, state.id, state.sourceRevision, state.errorCode, state.error])
    error = key === nativeFailureKey ? undefined : playbackIssue('audio-playback', state.error, '音频流加载失败，请重试', state.errorCode)
    nativeFailureKey = key
  } else nativeFailureKey = undefined
  usePlayerStore.setState({ status: state.stopped && state.status === 'buffering' ? 'resolving' : state.status || 'paused', progressSeconds: state.position || 0,
    ...(state.duration ? { durationSeconds: state.duration } : {}), ...(error === undefined ? {} : { error }) })
}
let nativeReady: Promise<void> | undefined
function ensureNativeReady() {
  if (!isMobile) return Promise.resolve()
  return nativeReady ??= observeMobileAudio(onNativeState)
    .then(async () => onNativeState(await snapshotMobileAudio()))
    .catch(error => { nativeReady = undefined; throw error })
}
void ensureNativeReady().then(() => applyLoudnessSetting()).catch(nativeError)
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

const nativeQueueWriter = isOHOS ? syncOHOSQueue : isIOS ? syncIOSQueue : syncAndroidQueue
function queueTrackOrigins(state: PlayerState, track: Track): VisibilityOrigin[] {
  if (state.queueOrigins?.[track.id]) return state.queueOrigins[track.id]
  if (useOfflinePlayback.getState().offline) {
    const parent = state.queueBase?.find(entry => isOfflineVideoRow(entry) && entry.source.bvid === track.source.bvid)
    if (parent) return state.queueOrigins?.[parent.id] ?? ['']
  }
  return ['']
}
const queueEntryOrder = (base: Track[]) => [...new Set(base.flatMap(track => [track.id, ...offlineEntries(track).map(part => part.id)]))]
function projectQueue(base: Track[], origins: PlayerState['queueOrigins'], rules: ReturnType<typeof useContentVisibility.getState>['rules']) {
  return uniqueTracks(base.flatMap(track => offlineEntries(track).filter(part => entryAllowed(part, origins?.[track.id] ?? [''], rules))))
}
const syncNativeQueue: typeof nativeQueueWriter = (tracks,mode,shuffled,threshold,source) => {
  const state = usePlayerStore.getState()
  const base = state.queueBase ?? tracks
  const entryOrigins = { ...state.queueOrigins }
  for (const track of base) for (const part of offlineEntries(track)) {
    entryOrigins[part.id] ??= entryOrigins[track.id] ?? ['']
  }
  return nativeQueueWriter(tracks,mode,shuffled,threshold,{...source,kind:source?.kind??'video',title:source?.title??'',entryOrigins,entryOrder:queueEntryOrder(base),offlineOnly:useOfflinePlayback.getState().offline})
}
function reorderVisibleBase(base:Track[],queue:Track[]) { const ids=new Set(queue.map(t=>t.id));let i=0;return base.map(track=>ids.has(track.id)?queue[i++]:track) }
function reprojectVisibility(offlineChanged = false) {
  const state = usePlayerStore.getState(), rules = useContentVisibility.getState().rules
  const base = state.queueBase ?? state.queue
  const queue = projectQueue(base, state.queueOrigins, rules)
  if (offlineChanged || queue.length!==state.queue.length || queue.some((track,i)=>track.id!==state.queue[i]?.id)) usePlayerStore.setState({queue})
}
useOfflinePlayback.subscribe((state, previous) => {
  if (state.offline !== previous.offline || state.library !== previous.library) reprojectVisibility(state.offline !== previous.offline)
})
useContentVisibility.subscribe((state,previous)=>{if(state.rules!==previous.rules && state.session) reprojectVisibility()})
if (isMobile) usePlayerStore.subscribe((state, previous) => {
  if (state.queue !== previous.queue || state.repeatMode !== previous.repeatMode || state.shuffled !== previous.shuffled || state.resumeThresholdSeconds !== previous.resumeThresholdSeconds || state.queueSource !== previous.queueSource) {
    nativeQueuePending = ensureNativeReady().then(() => {
      const current = usePlayerStore.getState()
      return syncNativeQueue(current.queue, current.repeatMode, current.shuffled, current.resumeThresholdSeconds, current.queueSource)
    })
    void nativeQueuePending.catch(error => console.warn('BiliMusic: queue update failed', error))
  }
})

// A recreated WebView must mirror its restored/adopted queue even before the
// user edits it. Read the native snapshot first to retain background advances.
if (isMobile) { nativeQueuePending = ensureNativeReady().then(() => {
  const state = usePlayerStore.getState()
  return syncNativeQueue(state.queue, state.repeatMode, state.shuffled, state.resumeThresholdSeconds, state.queueSource)
});void nativeQueuePending.catch(error => console.warn('BiliMusic: initial queue update failed', error)) }

// Resolve first; leave the current audio playing if a new quality is unavailable.
export async function reloadCurrentAudioSource() {
  const switchRequest=++sourceSwitchRequest
  pendingDesktopUpgrade=undefined
  const track=usePlayerStore.getState().current
  if (!track || loadedTrackId!==track.id) return
  const request=playRequest,seekRevision=desktopSeekRevision
  const valid=()=>request===playRequest&&seekRevision===desktopSeekRevision&&switchRequest===sourceSwitchRequest&&usePlayerStore.getState().current?.id===track.id
  const plan=await getTrackPlaybackPlan(track,true,true,useOfflinePlayback.getState().offline)
  const url=plan.url
  if(!valid())return
  if(isMobile){const state=usePlayerStore.getState();await playMobileAudio(track,url,playbackClock(),state.volume,state.status==='playing'||state.status==='buffering',loadedCollectionRef,state.rate,true,undefined,undefined,plan.loudnessGainDb);return}
  await switchDesktopSource(url,valid,plan.loudnessGainDb)
}

function maybeUpgradeDesktop() {
  const pending=pendingDesktopUpgrade
  if(!pending || !audio || usePlayerStore.getState().status!=='playing' || audio.currentTime<pending.startAt)return
  pendingDesktopUpgrade=undefined
  const seekRevision=desktopSeekRevision
  const valid=()=>pending.request===playRequest && pending.qualityIntent===sourceSwitchRequest && seekRevision===desktopSeekRevision
  if(valid())void switchDesktopSource(pending.url,valid).catch(()=>undefined)
}

async function switchDesktopSource(url:string, valid:()=>boolean, gainDb = trackGainDb) {
  const candidate=await prepareAudioSource(url,playbackClock,valid,usePlayerStore.getState().rate)
  try{
    if(!valid())return
    const shouldPlay=()=>['playing','buffering'].includes(usePlayerStore.getState().status)
    const deadline=performance.now()+5000
    do {
      candidate.playbackRate=usePlayerStore.getState().rate
      if(shouldPlay() && candidate.paused)await candidate.play()
      if(!valid())return
      await alignAudioSource(candidate,playbackClock,valid,deadline)
      if(!valid())return
      if(!shouldPlay())candidate.pause()
    } while(shouldPlay() && candidate.paused && performance.now()<deadline)
    if(shouldPlay() && candidate.paused)throw new Error('新音源暂时无法播放，已保留原音质')
    const previous=audio;bindAudioEvents(candidate);audio=candidate
    previous?.pause();previous?.removeAttribute('src');previous?.load()
    trackGainDb=safeGainDb(gainDb);applyDesktopOutput();candidate.muted=false
    usePlayerStore.setState({status:candidate.paused?'paused':'playing',progressSeconds:candidate.currentTime,error:null})
  }finally{if(audio!==candidate){candidate.pause();candidate.removeAttribute('src');candidate.load()}}
}

export async function prepareForApplicationUpdate() {
  flushPosition()
  flushPlayerSnapshot()
  await positionWrite.catch(() => undefined)
}
