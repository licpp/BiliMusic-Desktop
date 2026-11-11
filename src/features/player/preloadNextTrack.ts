import { invoke } from '@tauri-apps/api/core'
import { inDesktopShell } from '../../services/desktopApi'
import { prepareSeasonQueueEntry, usePlayerStore } from './playerStore'

export function startPreloadingNextTrack() {
  if (!inDesktopShell) return
  let scheduled = ''
  let timer: number | undefined

  function update() {
    const { current, queue, status, shuffled, repeatMode, progressSeconds, durationSeconds } = usePlayerStore.getState()
    let next
    if (current && status === 'playing' && durationSeconds > 0 && durationSeconds - progressSeconds <= 20 && !document.hidden && !shuffled && repeatMode !== 'one') {
      const index = queue.findIndex(track => track.id === current.id)
      if (index >= 0) next = queue[index + 1] ?? (repeatMode === 'all' ? queue[0] : undefined)
    }
    const source = next?.id !== current?.id && next?.source.provider === 'bilibili' ? next.source : undefined
    const key = source ? `${current?.id}:${source.bvid}:${source.cid}` : ''
    if (scheduled === key) return
    scheduled = key
    window.clearTimeout(timer)
    if (!source || !next) return

    // Resolve one predictable item shortly before playback ends. No media bytes
    // are fetched, and changing the queue cancels the scheduled request.
    const entry = next
    timer = window.setTimeout(() => {
      void (async () => {
        const target = entry.resolveParts ? (await prepareSeasonQueueEntry(entry))?.source : source
        if (target && target.cid > 0) await invoke('bili_warm_playback', { bvid: target.bvid, cid: target.cid })
      })().catch(() => undefined)
    }, 1500)
  }

  usePlayerStore.subscribe((state, previous) => {
    if (state.current?.id !== previous.current?.id || state.queue !== previous.queue ||
      state.status !== previous.status || state.repeatMode !== previous.repeatMode ||
      state.shuffled !== previous.shuffled || Math.floor(state.progressSeconds) !== Math.floor(previous.progressSeconds)) update()
  })
  document.addEventListener('visibilitychange', update)
  update()
}
