import { useOfflinePlayback } from './offlinePlayback'
import { invoke } from '@tauri-apps/api/core'
import { inDesktopShell } from '../../services/desktopApi'
import { accountEpoch } from '../../services/accountScope'
import { prepareSeasonQueueEntry, usePlayerStore } from './playerStore'

export function startPreloadingNextTrack() {
  if (!inDesktopShell) return
  let scheduled = ''
  let timer: number | undefined

  function update() {
    const { current, queue, status, shuffled, repeatMode, progressSeconds, durationSeconds } = usePlayerStore.getState()
    let next
    if (!useOfflinePlayback.getState().offline && current && status === 'playing' && durationSeconds > 0 && (progressSeconds >= 3 || durationSeconds - progressSeconds <= 20) && !shuffled && repeatMode !== 'one') {
      const index = queue.findIndex(track => track.id === current.id)
      if (index >= 0) next = queue[index + 1] ?? (repeatMode === 'all' ? queue[0] : undefined)
    }
    const source = next?.id !== current?.id && next?.source.provider === 'bilibili' ? next.source : undefined
    const key = source ? `${current?.id}:${source.bvid}:${source.cid}` : ''
    if (scheduled === key) return
    scheduled = key
    window.clearTimeout(timer)
    if (!source || !next) return

    // Warm one predictable successor after playback settles. The backend caps
    // media prefetch to the first/last cache block and reuses normal range requests.
    const entry = next
    const epoch = accountEpoch()
    timer = window.setTimeout(() => {
      void (async () => {
        const target = entry.resolveParts ? (await prepareSeasonQueueEntry(entry))?.source : source
        if (scheduled !== key || epoch !== accountEpoch()) return
        if (target && target.cid > 0) await invoke('bili_warm_playback', { bvid: target.bvid, cid: target.cid })
      })().catch(() => undefined)
    }, 800)
  }

  usePlayerStore.subscribe((state, previous) => {
    if (state.current?.id !== previous.current?.id || state.queue !== previous.queue ||
      state.status !== previous.status || state.repeatMode !== previous.repeatMode ||
      state.shuffled !== previous.shuffled || Math.floor(state.progressSeconds) !== Math.floor(previous.progressSeconds)) update()
  })
  useOfflinePlayback.subscribe((state, previous) => { if (state.offline !== previous.offline) update() })
  document.addEventListener('visibilitychange', update)
  update()
}
