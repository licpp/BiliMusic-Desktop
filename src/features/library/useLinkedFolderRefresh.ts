import { useCallback, useEffect, useState } from 'react'
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountEpoch } from '../../services/accountScope'
import { biliPauseMessage, biliRequestPause } from '../../services/biliRequestStatus'
import { linkedRefreshKey, loadStaleLinkedFolder, reloadLinkedFolder, type LinkedRefreshState } from '../../services/linkedFolders'
import { commandErrorMessage } from '../../services/userErrors'

export function useLinkedFolderRefresh(folderId: number | undefined, localPending: boolean, offline: boolean) {
  const client = useQueryClient()
  const epoch = accountEpoch()
  const { data } = useQuery<LinkedRefreshState>({
    queryKey: linkedRefreshKey(folderId),
    queryFn: skipToken,
  })
  const refreshing = Boolean(data?.refreshing)
  const error = data?.error
  const pause = biliRequestPause(error)
  const wait = Math.max(0, (pause?.retryAt ?? 0) - Date.now())
  // Re-render once the button can be enabled. Do not send a request from the timer.
  const [, renderDeadline] = useState(0)
  useEffect(() => {
    if (!wait) return
    const timer = window.setTimeout(() => renderDeadline(value => value + 1), Math.min(wait, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [wait])

  const canRetry = !offline && !refreshing && !wait
  const refresh = useCallback(async () => {
    if (folderId === undefined || !canRetry) return
    await reloadLinkedFolder(client, folderId).catch(() => undefined)
  }, [client, folderId, canRetry])

  useEffect(() => {
    if (folderId === undefined || localPending || offline) return
    void loadStaleLinkedFolder(client, folderId)?.catch(() => undefined)
  }, [client, epoch, folderId, localPending, offline])

  const message = pause ? biliPauseMessage(pause) : error ? commandErrorMessage(error) : ''
  return { refreshing, refresh, error, read: data?.read ?? 0, message, pause, paused: Boolean(pause), canRetry }
}
