import { accountKeyAt, accountQueryKey } from './queryKeys'
import type { QueryClient } from '@tanstack/react-query'
import { accountEpoch } from './accountScope'
import { refreshLinkedFolder } from './desktopApi'
import type { LinkedFolder } from '../domain/bilibili'
import { biliRequestPause } from './biliRequestStatus'

export const linkedFolderKey = (folderId: number) => accountQueryKey('linked-bili-folder', folderId)
export const linkedRefreshKey = (folderId: number | undefined) => accountQueryKey('linked-bili-folder-refresh', folderId)
export type LinkedRefreshState = {
  refreshing: boolean
  read: number
  error?: unknown
}

const refreshing = new Map<string, Promise<LinkedFolder>>()
const freshnessSeconds = 5 * 60

export function loadStaleLinkedFolder(client: QueryClient, folderId: number, now = Date.now()) {
  const snapshot = client.getQueryData<LinkedFolder | null>(linkedFolderKey(folderId))
  const refreshedAt = snapshot?.refreshedAt ?? 0
  const age = now / 1000 - refreshedAt
  if (refreshedAt > 0 && age >= 0 && age < freshnessSeconds) return
  const pause = biliRequestPause(client.getQueryData<LinkedRefreshState>(linkedRefreshKey(folderId))?.error)
  if (pause && (pause.reason !== 'rateLimited' || (pause.retryAt ?? 0) > now)) return
  return reloadLinkedFolder(client, folderId, false, true)
}

export function reloadLinkedFolder(client: QueryClient, folderId: number, link = false, background = false) {
  const epoch = accountEpoch()
  const key = `${epoch}:${folderId}:${link}`
  const pending = refreshing.get(key)
  if (pending) return pending
  const statusKey = accountKeyAt(epoch, 'linked-bili-folder-refresh', folderId)
  const queryKey = accountKeyAt(epoch, 'linked-bili-folder', folderId)
  let read = 0
  let finished = false
  client.setQueryData<LinkedRefreshState>(statusKey, { refreshing: true, read })
  const request = refreshLinkedFolder(folderId, link, background, count => {
    if (epoch !== accountEpoch() || finished) return
    read = count
    client.setQueryData<LinkedRefreshState>(statusKey, { refreshing: true, read })
  }).then(async folder => {
    finished = true
    if (epoch === accountEpoch()) {
      // A slow local cache read must not overwrite the completed remote snapshot.
      await client.cancelQueries({ queryKey, exact: true })
      if (epoch !== accountEpoch()) return folder
      client.setQueryData(queryKey, folder)
      client.setQueryData<LinkedRefreshState>(statusKey, { refreshing: false, read: 0 })
      await client.invalidateQueries({ queryKey: accountQueryKey('playlists') })
    }
    return folder
  }, error => {
    finished = true
    if (epoch === accountEpoch()) client.setQueryData<LinkedRefreshState>(statusKey, { refreshing: false, read, error })
    throw error
  }).finally(() => refreshing.delete(key))
  refreshing.set(key, request)
  return request
}
