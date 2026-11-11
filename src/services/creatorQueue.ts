import { invoke } from '@tauri-apps/api/core'
import { usePlayerStore } from '../features/player/playerStore'
import { creatorVideoRow, seasonTracks, type SeasonVideo } from './mediaSources'
import { accountEpoch } from './accountScope'

// Extend the existing queue before reaching the loaded page's last few videos.
// The subscription survives navigation away from the creator page.
export function startCreatorQueue() {
  let pending = false
  let retryAfter = 0
  usePlayerStore.subscribe(async (state) => {
    const source = state.queueSource
    if (
      pending ||
      Date.now() < retryAfter ||
      !source?.creatorMid ||
      !state.current
    )
      return
    const videos = [...new Set(state.queue.map((track) => track.source.bvid))]
    const at = videos.indexOf(state.current.source.bvid)
    if (at < videos.length - 5 || videos.length >= (source.creatorTotal || 0))
      return
    pending = true
    const scope = accountEpoch()
    try {
      const next = (source.creatorPage || 1) + 1
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
        mid: source.creatorMid,
        page: next,
      })
      const current = usePlayerStore.getState()
      if (
        scope !== accountEpoch() ||
        current.queueSource?.creatorMid !== source.creatorMid ||
        current.queueSource.creatorPage !== source.creatorPage
      )
        return
      const known = new Set(current.queue.map((track) => track.source.bvid))
      const rows: SeasonVideo[] = result.data.list.vlist
        .filter((video) => !known.has(video.bvid))
        .map(creatorVideoRow)
      const tracks = seasonTracks({
        unavailable: 0,
        summary: {
          id: source.creatorMid,
          uploaderId: source.creatorMid,
          title: source.title,
          uploaderName: source.title,
          coverUrl: '',
        },
        tracks: rows,
      })
      usePlayerStore.setState({
        queue: [...current.queue, ...tracks],
        queueSource: {
          ...source,
          creatorPage: next,
          creatorTotal: result.data.list.vlist.length
            ? result.data.page.count
            : videos.length,
        },
      })
    } catch {
      retryAfter = Date.now() + 30000
    } finally {
      pending = false
    }
  })
}
