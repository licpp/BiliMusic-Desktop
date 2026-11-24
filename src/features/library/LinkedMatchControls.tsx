import { useEffect, useState } from 'react'
import { LoaderCircle, Pause, Play, Sparkles } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { biliPauseMessage, openBiliVerification, type BiliPause } from '../../services/biliRequestStatus'
import { cancelLinkedMatch, loadLinkedMatch, pauseLinkedMatch, runLinkedMatch, useLinkedMatchJobs } from '../../services/linkedBatchMatching'
import { accountQueryKey } from '../../services/queryKeys'
import { commandErrorMessage } from '../../services/userErrors'
import { useOfflinePlayback } from '../player/offlinePlayback'
import { usePlayerStore } from '../player/playerStore'

export function useLinkedMatchControls(folderId: number) {
  const client = useQueryClient()
  const status = useLinkedMatchJobs(state => state[folderId])
  const offline = useOfflinePlayback(state => state.offline)
  const epoch = accountEpoch()
  const callbacks = {
    onMatched: (track: Track) => {
      const player = usePlayerStore.getState()
      const existing = player.current?.id === track.id ? player.current
        : player.queue.find(item => item.id === track.id) ?? player.queueBase?.find(item => item.id === track.id)
      if (existing) player.updateTrack({ ...existing, title: track.title, displayTitle: track.displayTitle,
        artist: track.artist, album: track.album, coverUrl: track.coverUrl || existing.coverUrl, titleOverridden: true })
    },
    onChanged: () => {
      void client.invalidateQueries({ queryKey: accountQueryKey('library') })
      void client.invalidateQueries({ queryKey: accountQueryKey('playlists') })
    },
  }
  return {
    status, offline, epoch,
    canStart: !offline && !status?.working && status?.job?.state !== 'paused' && status?.job?.state !== 'running',
    start: (tracks: Track[], partsOnly = false) => runLinkedMatch(folderId, callbacks, { tracks, partsOnly }),
    resume: () => runLinkedMatch(folderId, callbacks),
  }
}

export function LinkedMatchButton({ folderId, tracks }: { folderId: number; tracks: Track[] }) {
  const matching = useLinkedMatchControls(folderId)
  return <button type="button" disabled={!tracks.length || !matching.canStart} onClick={() => void matching.start(tracks, true)} title="同时匹配歌曲信息与歌词">
    <Sparkles size={16}/>自动匹配
  </button>
}

export function LinkedMatchStatus({ folderId, large = false, refreshPause }: { folderId: number; large?: boolean; refreshPause?: BiliPause }) {
  const { status, offline, epoch, resume } = useLinkedMatchControls(folderId)
  const [openerError, setOpenerError] = useState('')
  const [, tick] = useState(0)
  useEffect(() => { setOpenerError(''); void loadLinkedMatch(folderId) }, [folderId, epoch])
  const job = status?.job
  const wait = job?.state === 'paused' && job.retryAt ? Math.max(0, job.retryAt - Date.now()) : 0
  useEffect(() => {
    if (!wait) return
    const timer = window.setTimeout(() => tick(value => value + 1), Math.min(wait, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [wait])

  if (!status || (!job && !status.working && !status.error)) return null
  const working = status.working && job?.state !== 'paused'
  const paused = job && (job.state === 'paused' || job.state === 'running' && !status.working)
  const reason = job?.reason
  const stage = !job ? (working ? '正在准备匹配…' : '') : working ? '匹配中' : paused ? '匹配已暂停' : job.state === 'cancelled' ? '匹配已取消' : '匹配完成'
  const duplicatePause = refreshPause && refreshPause.reason === reason && refreshPause.retryAt === job?.retryAt
  const detail = reason === 'rateLimited' || reason === 'verificationRequired' || reason === 'authRequired'
    ? biliPauseMessage({ reason, retryAt: job?.retryAt })
    : reason === 'network' ? '网络连接中断' : ''
  const finished = job?.state === 'completed' || job?.state === 'cancelled'
  const skipped = job ? job.skipped - job.protected - job.unmatched - job.conflicts : 0
  const feedback = [stage, job && `${job.done}/${job.total} 个视频`, job && `已匹配 ${job.matched} 首`,
    finished && job?.protected && `保留已有 ${job.protected} 首`, finished && job?.unmatched && `未匹配 ${job.unmatched} 首`,
    finished && job?.conflicts && `已更新 ${job.conflicts} 首`, finished && skipped > 0 && `跳过 ${skipped} 项`,
    finished && job?.failed && `失败 ${job.failed} 项`,
    paused && !duplicatePause && detail, status.error || openerError,
  ].filter(Boolean).join(' · ')
  return <div className={large ? 'large-toolbar linked-match-status' : 'collection-actions linked-match-status'}>
    <span className="batch-match-progress" role="status">{working && <LoaderCircle size={13} className="spin"/>}{feedback}</span>
    {working && job?.state === 'running' && <button type="button" onClick={() => void pauseLinkedMatch(folderId)}><Pause size={16}/>暂停匹配</button>}
    {paused && <div className="linked-match-actions">
      {reason === 'verificationRequired' && !duplicatePause && <button type="button" onClick={() => { setOpenerError(''); void openBiliVerification().catch(error => { if (epoch === accountEpoch()) setOpenerError(commandErrorMessage(error)) }) }}>前往 B 站</button>}
      <button type="button" disabled={Boolean(status.working || offline || wait)} onClick={() => { setOpenerError(''); void resume() }}><Play size={16}/>继续匹配</button>
      <button type="button" disabled={status.working} onClick={() => void cancelLinkedMatch(folderId)}>取消任务</button>
    </div>}
  </div>
}
