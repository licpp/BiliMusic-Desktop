import { invoke } from '@tauri-apps/api/core'
import { appendCreatorQueuePage, usePlayerStore, type QueueSource } from './playerStore'
import { creatorVideoRow } from '../../services/mediaSources'
import { accountEpoch } from '../../services/accountScope'

// Extend the existing queue before reaching the loaded page's last few videos.
// The subscription survives navigation away from the creator page.
export function startCreatorQueue() {
  let pending = false
  let disposed = false
  let retrySource: QueueSource | undefined
  let retryAfter = 0

  async function loadNextPage(state: ReturnType<typeof usePlayerStore.getState>) {
    const source = state.queueSource
    if (
      disposed || pending ||
      (source === retrySource && Date.now() < retryAfter) ||
      !source?.creatorMid ||
      !state.current
    )
      return
    const creatorMid = source.creatorMid
    const videos = [...new Set(state.queue.map((track) => track.source.bvid))]
    const at = videos.indexOf(state.current.source.bvid)
    if (at < videos.length - 5) return
    const base = state.queueBase ?? state.queue
    if (new Set(base.map(track => track.source.bvid)).size >= (source.creatorTotal || 0))
      return

    const expected = { source, page: source.creatorPage ?? 1, epoch: accountEpoch() }
    let applied = false
    pending = true
    try {
      const result = await invoke<{
        data: {
          list: {
            vlist: {
              bvid: string
              aid: number
              title: string
              pic: string
              length?: string
              duration?: number
              play?: number
            }[]
          }
          page: { count: number }
        }
      }>('bili_creator_catalog', {
        action: 'videos',
        mid: creatorMid,
        page: expected.page + 1,
        keyword: source.creatorKeyword || '',
      })
      if (disposed) return
      const tracks = result.data.list.vlist.map(video => creatorVideoRow(video, creatorMid, source.title))
      applied = appendCreatorQueuePage(expected, tracks, result.data.page.count)
    } catch {
      retrySource = source
      retryAfter = Date.now() + 30000
    } finally {
      pending = false
      const current = usePlayerStore.getState()
      if (!disposed && !applied && current.queueSource !== source) void loadNextPage(current)
    }
  }

  const unsubscribe = usePlayerStore.subscribe(loadNextPage)
  return () => {
    disposed = true
    unsubscribe()
  }
}
