import type { QueryClient } from '@tanstack/react-query'
import { startAutomaticLyrics } from '../features/lyrics/automaticLyrics'
import { startCreatorQueue } from '../features/player/creatorQueue'
import { startPreloadingNextTrack } from '../features/player/preloadNextTrack'
import { startFloatingLyrics } from '../features/lyrics/floatingLyricsRuntime'
import { startListeningStatistics } from '../features/player/listeningStatistics'
import { installAccountQueryScope } from '../services/queryKeys'
import { startCloudSync } from '../features/sync/librarySync'
import { startUpdateChecks } from '../services/updates'
import { installLocalPlayback } from './localPlayback'

export function installMainWindowRuntime(client: QueryClient) {
  const stop = [
    installAccountQueryScope(client),
    installLocalPlayback(client),
    startUpdateChecks(),
    startCloudSync(client),
    startAutomaticLyrics(),
    startListeningStatistics(),
    startPreloadingNextTrack(),
    startCreatorQueue(),
    startFloatingLyrics(),
  ]
  return () => {
    while (stop.length) stop.pop()?.()
  }
}
