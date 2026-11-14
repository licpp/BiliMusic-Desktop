import type { QueryClient } from '@tanstack/react-query'
import { accountEpoch } from './accountScope'
import { refreshLinkedFolder, type LinkedFolder } from './desktopApi'

export const linkedFolderKey = (folderId: number) => ['linked-bili-folder', folderId]

const refreshing = new Map<string, Promise<LinkedFolder>>()

export function reloadLinkedFolder(client: QueryClient, folderId: number, link = false) {
  const epoch = accountEpoch()
  const key = `${epoch}:${folderId}:${link}`
  const pending = refreshing.get(key)
  if (pending) return pending
  const request = refreshLinkedFolder(folderId, link).then(async folder => {
    if (epoch === accountEpoch()) {
      // A slow local cache read must not overwrite the completed remote snapshot.
      await client.cancelQueries({ queryKey: linkedFolderKey(folderId), exact: true })
      if (epoch !== accountEpoch()) return folder
      client.setQueryData(linkedFolderKey(folderId), folder)
      await client.invalidateQueries({ queryKey: ['playlists'] })
    }
    return folder
  }).finally(() => refreshing.delete(key))
  refreshing.set(key, request)
  return request
}
