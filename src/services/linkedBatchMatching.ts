import { invoke, isTauri } from '@tauri-apps/api/core'
import { create } from 'zustand'
import type { Track } from '../domain/track'
import { accountEpoch } from './accountScope'
import { matchBatchTrack, notifyBatchLyrics, type BatchMatchProgress } from './batchMatching'
import { biliRequestPause, isUnavailableBiliVideo, type BiliPause } from './biliRequestStatus'
import { toTrack } from './collectionTrack'
import { fromStoredTrack, getVideoParts, toTrackInput } from './desktopApi'
import { commandErrorMessage, isConnectionError } from './userErrors'

type TrackInput = ReturnType<typeof toTrackInput>
type PauseReason = BiliPause['reason'] | 'network' | 'other' | 'user'
type TrackOutcome = 'protected' | 'unmatched' | 'conflict' | 'skipped' | 'failed'
type Job = BatchMatchProgress & {
  runId: string
  state: 'running' | 'paused' | 'completed' | 'cancelled'
  reason?: PauseReason
  retryAt?: number
  next?: { bvid: string; tracks?: TrackInput[] }
}
type Update =
  | { kind: 'resolve'; bvid: string; tracks: TrackInput[] }
  | { kind: 'skipVideo'; bvid: string; outcome: 'skipped' | 'failed' }
  | { kind: 'finishTrack'; bvid: string; trackId: string; outcome: TrackOutcome }
  | { kind: 'pause'; reason: PauseReason; retryAt?: number }
  | { kind: 'cancel' }
type FolderStatus = { job?: Job | null; working?: boolean; error?: string }
type StatusMap = Record<number, FolderStatus | undefined>
type Run = { epoch: number; stopped: boolean; session?: string; job?: Job; stopping?: Promise<void> }

export const useLinkedMatchJobs = create<StatusMap>(() => ({}))
const running = new Map<number, Run>()
const loading = new Map<number, Promise<void>>()
const updateStatus = (folderId: number, status: FolderStatus) =>
  useLinkedMatchJobs.setState(current => ({ [folderId]: { ...current[folderId], ...status } }))

if (typeof window !== 'undefined') window.addEventListener('bilimusic-account-changing', () => {
  running.clear()
  loading.clear()
  useLinkedMatchJobs.setState({}, true)
})

const readJob = (folderId: number, expectedSession: string) =>
  invoke<Job | null>('linked_batch_match_job', { folderId, expectedSession })
const writeJob = (folderId: number, expectedSession: string, runId: string, update: Update) =>
  invoke<Job>('linked_batch_match_update', { folderId, expectedSession, runId, update })

export function loadLinkedMatch(folderId: number) {
  if (!isTauri() || useLinkedMatchJobs.getState()[folderId]?.working || running.has(folderId)) return
  if (loading.has(folderId)) return loading.get(folderId)
  const epoch = accountEpoch()
  const current = () => epoch === accountEpoch() && loading.get(folderId) === request && !running.has(folderId)
  const request = invoke<string>('account_session').then(async session => {
    if (!current()) return
    const job = await readJob(folderId, session)
    if (current()) updateStatus(folderId, { job, error: undefined })
  }).catch(error => {
    if (current()) updateStatus(folderId, { error: commandErrorMessage(error) })
  }).finally(() => { if (loading.get(folderId) === request) loading.delete(folderId) })
  loading.set(folderId, request)
  return request
}

export type LinkedMatchSelection = { tracks: Track[]; partsOnly?: boolean }

export async function runLinkedMatch(folderId: number, callbacks: { onMatched: (track: Track) => void; onChanged: () => void }, selection?: LinkedMatchSelection) {
  if (running.has(folderId) || useLinkedMatchJobs.getState()[folderId]?.working || selection?.tracks.length === 0) return
  const run: Run = { epoch: accountEpoch(), stopped: false }
  const current = () => run.epoch === accountEpoch() && running.get(folderId) === run
  const check = () => { if (!current() || run.stopped) throw new DOMException('匹配已暂停', 'AbortError') }
  running.set(folderId, run)
  loading.delete(folderId)
  updateStatus(folderId, { working: true, error: undefined })

  let changed = false
  let savedAny = false
  let lastRefresh = 0
  const publishSaved = () => {
    if (!changed || !current()) return
    changed = false
    lastRefresh = Date.now()
    callbacks.onChanged()
  }
  try {
    const session = await invoke<string>('account_session')
    check()
    run.session = session
    const job = await invoke<Job>('linked_batch_match_start', {
      folderId, expectedSession: session,
      ...(selection && { bvids: [...new Set(selection.tracks.map(track => track.source.bvid))] }),
      ...(selection?.partsOnly && { tracks: selection.tracks.map(toTrackInput) }),
    })
    if (!current()) return
    run.job = job
    updateStatus(folderId, { job })
    const update = async (change: Update) => {
      check()
      const next = await writeJob(folderId, session, job.runId, change)
      check()
      run.job = next
      updateStatus(folderId, { job: next })
    }

    while (run.job.state === 'running' && run.job.next) {
      check()
      const { bvid, tracks } = run.job.next
      if (!tracks) {
        let detail
        try {
          detail = await getVideoParts(bvid, false, { background: true, resume: true })
        }
        catch (error) {
          check()
          if (!isUnavailableBiliVideo(error)) throw error
          await update({ kind: 'skipVideo', bvid, outcome: 'skipped' })
          continue
        }
        check()
        const parts = detail.parts.filter(part => part.cid > 0).map(part => toTrackInput(toTrack(detail, part)))
        await update(parts.length ? { kind: 'resolve', bvid, tracks: parts } : { kind: 'skipVideo', bvid, outcome: 'failed' })
        continue
      }
      const input = tracks[0]
      const track = fromStoredTrack({ ...input, sourceDisplayTitle: input.title, sourceVideoTitle: input.sourceTitle, liked: false })
      const result = await matchBatchTrack(track, check, true, { folderId, runId: job.runId, bvid, session })
      if (result.outcome === 'matched' || result.outcome === 'conflict') {
        if (result.outcome === 'matched') {
          changed = true
          savedAny = true
          callbacks.onMatched(result.track)
          if (Date.now() - lastRefresh >= 750) publishSaved()
          await notifyBatchLyrics(track.id, check)
        }
        const updated = await readJob(folderId, session)
        check()
        if (!updated) break
        run.job = updated
        updateStatus(folderId, { job: updated })
      } else {
        await update({ kind: 'finishTrack', bvid, trackId: track.id, outcome: result.outcome })
      }
    }
  } catch (error) {
    if (!current() || run.stopped) return
    const pause = biliRequestPause(error)
    const reason = pause?.reason ?? (isConnectionError(error) || globalThis.navigator?.onLine === false ? 'network' : 'other')
    if (reason === 'other') updateStatus(folderId, { error: commandErrorMessage(error) })
    if (run.session && run.job?.state === 'running') {
      await persistPause(folderId, run, { kind: 'pause', reason, retryAt: pause?.retryAt })
    } else if (current() && reason !== 'other') {
      updateStatus(folderId, { error: commandErrorMessage(error) })
    }
  } finally {
    if (current()) {
      if (run.stopped && run.job?.state === 'running') await pauseRun(folderId, run)
      if (current()) {
        if (run.stopped) callbacks.onChanged()
        publishSaved()
        if (savedAny) window.dispatchEvent(new Event('bilimusic-data-changed'))
        running.delete(folderId)
        updateStatus(folderId, { working: false })
      }
    }
  }
}

async function persistPause(folderId: number, run: Run, change: Extract<Update, { kind: 'pause' }>) {
  if (!run.session || !run.job) return
  const current = () => run.epoch === accountEpoch() && running.get(folderId) === run
  try {
    const job = await writeJob(folderId, run.session, run.job.runId, change)
    if (current()) {
      run.job = job
      updateStatus(folderId, { job })
    }
  } catch (error) {
    if (current()) updateStatus(folderId, { error: commandErrorMessage(error) })
  }
}

function pauseRun(folderId: number, run: Run) {
  if (!run.job) return
  return run.stopping ??= persistPause(folderId, run, { kind: 'pause', reason: 'user' })
}

export function pauseLinkedMatch(folderId: number) {
  const run = running.get(folderId)
  if (!run) return
  run.stopped = true
  return pauseRun(folderId, run)
}

export async function cancelLinkedMatch(folderId: number) {
  const state = useLinkedMatchJobs.getState()[folderId]
  if (!state?.job || state.working || running.has(folderId)) return
  const { runId } = state.job
  const epoch = accountEpoch()
  loading.delete(folderId)
  updateStatus(folderId, { working: true, error: undefined })
  try {
    const session = await invoke<string>('account_session')
    if (epoch !== accountEpoch()) return
    const job = await writeJob(folderId, session, runId, { kind: 'cancel' })
    if (epoch === accountEpoch()) updateStatus(folderId, { job })
  } catch (error) {
    if (epoch === accountEpoch()) updateStatus(folderId, { error: commandErrorMessage(error) })
  } finally {
    if (epoch === accountEpoch()) updateStatus(folderId, { working: false })
  }
}
