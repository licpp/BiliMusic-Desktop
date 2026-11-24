import type { QueryClient } from '@tanstack/react-query'
import { startOfflinePlayback } from '../features/player/offlinePlayback'
import { inDesktopShell, listOfflinePlayableTracks } from '../services/desktopApi'

export function installLocalPlayback(client: QueryClient) {
  // These queries read the account's local database. Remote catalog queries
  // still use the normal network policy.
  for (const key of ['library', 'playlists', 'home-recent', 'linked-bili-folder', 'imported-entries', 'collections', 'list-preferences', 'collection-progress', 'search-history']) {
    client.setQueryDefaults([key], { networkMode: 'always' })
  }
  if (inDesktopShell) startOfflinePlayback(listOfflinePlayableTracks)
}
