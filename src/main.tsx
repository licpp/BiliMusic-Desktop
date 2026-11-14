import { FloatingLyricsUnlockWindow } from './features/lyrics/FloatingLyricsUnlockWindow'
import { SubtitleController } from './features/lyrics/useBiliSubtitles'
import { FloatingLyricsWindow } from './features/lyrics/FloatingLyricsWindow'
import { startFloatingLyrics } from './services/floatingLyrics'
import { startCreatorQueue } from './services/creatorQueue'
import { startPreloadingNextTrack } from './features/player/preloadNextTrack'
import { startListeningStatistics } from './services/listeningStatistics'
import { startCloudSync } from './services/sync'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './app/App'
import { isAndroid, isIOS, isOHOS, isMobile } from './services/platform'
import { installMobileKeyboard } from './shared/mobileKeyboard'
import { installMobileGestures } from './shared/mobileGestures'
import { startAutomaticLyrics } from './features/lyrics/automaticLyrics'
import './styles/global.css'
import './styles/theme.css'
import './styles/mobile.css'
import './styles/immersive.css'
import './styles/comments.css'

document.documentElement.dataset.platform = isOHOS ? 'ohos' : isIOS ? 'ios' : isAndroid ? 'android' : 'desktop'
document.documentElement.dataset.layout = isMobile ? 'mobile' : 'desktop'
installMobileGestures()
installMobileKeyboard()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

const floatingMode = new URLSearchParams(location.search).get('window')
const floating = !isMobile && (floatingMode === 'lyrics' || floatingMode === 'lyrics-unlock')
if (!floating) {
  startCloudSync(queryClient)
  startAutomaticLyrics()
  startListeningStatistics()
  startPreloadingNextTrack()
  startCreatorQueue()
  startFloatingLyrics()
}
createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}>{floating ? floatingMode === 'lyrics-unlock' ? <FloatingLyricsUnlockWindow/> : <FloatingLyricsWindow/> : <><SubtitleController/><App/></>}</QueryClientProvider></StrictMode>,
)

import './styles/collections.css'
import './styles/downloads.css'

import './styles/mobile-pages.css'

import './styles/media-features.css'

import './styles/queue.css'
import './styles/playlist-import.css'
import './styles/mini-player.css'
import './styles/playback-cache.css'
import './styles/search-suggestions.css'
import './styles/editor-polish.css'

import './styles/list-toolbar.css'
