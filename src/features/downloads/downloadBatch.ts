import type { QueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage, downloadTrack, saveLibraryTrack } from '../../services/desktopApi'
import { chooseDownloadDirectory, getDownloadDirectory } from '../../services/settings'

type Batch = { total: number; completed: number; skipped: number; failures: string[] }
export const useDownloadBatch = create<{ busy: boolean; batch: Batch | null }>(() => ({ busy: false, batch: null }))

window.addEventListener('bilimusic-account-changing', () => useDownloadBatch.setState({ batch: null }))

export async function startDownloadBatch(tracks: Track[], client: QueryClient) {
  const items = [...new Map(tracks.filter(track => track.source.provider === 'bilibili').map(track => [track.id, track])).values()]
  if (!items.length || useDownloadBatch.getState().busy) return false
  const epoch = accountEpoch()
  useDownloadBatch.setState({ busy: true, batch: null })
  try {
    const directory = await getDownloadDirectory() || await chooseDownloadDirectory()
    if (!directory || epoch !== accountEpoch()) return false
    const batch: Batch = { total: items.length, completed: 0, skipped: 0, failures: [] }
    useDownloadBatch.setState({ batch })
    void (async () => {
      try {
        for (const track of items) {
          if (epoch !== accountEpoch()) break
          try {
            const saved = await saveLibraryTrack(track)
            if (epoch !== accountEpoch()) break
            const request = downloadTrack(saved, directory, true)
            void client.invalidateQueries({ queryKey: ['downloads'] })
            if (await request) batch.completed++
            else batch.skipped++
          } catch (cause) {
            batch.failures.push(`${track.title}：${commandErrorMessage(cause)}`)
          }
          if (epoch === accountEpoch()) useDownloadBatch.setState({ batch: { ...batch, failures: [...batch.failures] } })
          void client.invalidateQueries({ queryKey: ['downloads'] })
        }
      } finally {
        useDownloadBatch.setState({ busy: false })
      }
    })()
    return true
  } finally {
    if (!useDownloadBatch.getState().batch) useDownloadBatch.setState({ busy: false })
  }
}
