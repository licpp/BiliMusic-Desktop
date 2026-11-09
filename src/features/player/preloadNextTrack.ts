import { invoke } from '@tauri-apps/api/core'
import { inDesktopShell } from '../../services/desktopApi'
import { usePlayerStore } from './playerStore'

export function startPreloadingNextTrack() {
  if (!inDesktopShell) return
  let scheduled = ''
  let timer: number | undefined

  function update() {
    const { current, queue, status, shuffled, repeatMode } = usePlayerStore.getState()
    let next
    if (current && status === 'playing' && !document.hidden && !shuffled && repeatMode !== 'one') {
      const index = queue.findIndex(track => track.id === current.id)
      if (index >= 0) next = queue[index + 1] ?? (repeatMode === 'all' ? queue[0] : undefined)
    }
    const source = next?.id !== current?.id && next?.source.provider === 'bilibili' ? next.source : undefined
    const key = source ? `${current?.id}:${source.bvid}:${source.cid}` : ''
    if (scheduled === key) return
    scheduled = key
    window.clearTimeout(timer)
    if (!source) return

    // Resolve one predictable item after playback settles. No media bytes
    // are fetched, and changing the queue cancels the scheduled request.
    timer = window.setTimeout(() => {
      void invoke('bili_warm_playback', { bvid: source.bvid, cid: source.cid }).catch(() => undefined)
    }, 1500)
  }

  usePlayerStore.subscribe((state, previous) => {
    if (state.current?.id !== previous.current?.id || state.queue !== previous.queue ||
      state.status !== previous.status || state.repeatMode !== previous.repeatMode ||
      state.shuffled !== previous.shuffled) update()
  })
  document.addEventListener('visibilitychange', update)
  update()
}
