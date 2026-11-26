import './shared/runtimeCompatibility'
import { retryOnceUnlessBiliPaused } from './services/biliRequestStatus'
import './styles/components/content-visibility.css'
import { installAccountQueryScope } from './services/queryKeys'
import { FloatingLyricsUnlockWindow } from './features/lyrics/FloatingLyricsUnlockWindow'
import { SubtitleController } from './features/lyrics/useBiliSubtitles'
import { FloatingLyricsWindow } from './features/lyrics/FloatingLyricsWindow'
import { installMainWindowRuntime } from './app/mainWindowRuntime'
import { StrictMode, useEffect } from 'react'
import { installStartupDiagnostics } from './services/diagnostics'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './app/App'
import { isAndroid, isIOS, isOHOS, isMobile } from './services/platform'
import { installOHOSWindowInsets } from './services/immersiveWindow'
import { installOverlayBack } from './shared/overlayStack'
import { installMobileKeyboard } from './shared/mobileKeyboard'
import { installMobileGestures } from './shared/mobileGestures'
import { TrayPlayer } from './features/player/TrayPlayer'
import './styles/global.css'
import './styles/theme.css'
import './styles/mobile.css'
import './styles/immersive.css'
import './styles/comments.css'

document.documentElement.dataset.platform = isOHOS ? 'ohos' : isIOS ? 'ios' : isAndroid ? 'android' : 'desktop'
document.documentElement.dataset.layout = isMobile ? 'mobile' : 'desktop'
installMobileGestures()
installMobileKeyboard()
installOverlayBack()
const windowLayoutReady = isOHOS ? installOHOSWindowInsets() : undefined

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: retryOnceUnlessBiliPaused,
      refetchOnWindowFocus: false,
    },
  },
})

const floatingMode = new URLSearchParams(location.search).get('window')
const floating = !isMobile && (floatingMode === 'lyrics' || floatingMode === 'lyrics-unlock')
const tray = !isMobile && floatingMode === 'tray'
if (tray) {
  document.documentElement.dataset.auxWindow = 'tray'
  document.getElementById('app-bootstrap')?.remove()
}
const diagnoseReady = !floating && !tray ? installStartupDiagnostics() : undefined
function DiagnosticBoot() { useEffect(() => { diagnoseReady?.() }, []); return null }
const stopRuntime = floating || tray ? installAccountQueryScope(queryClient) : installMainWindowRuntime(queryClient)
import.meta.hot?.dispose(stopRuntime)
function mount() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode><QueryClientProvider client={queryClient}>{tray ? <TrayPlayer/> : floating ? floatingMode === 'lyrics-unlock' ? <FloatingLyricsUnlockWindow/> : <FloatingLyricsWindow/> : <><SubtitleController/><App/><DiagnosticBoot/></>}</QueryClientProvider></StrictMode>,
  )
}

if (windowLayoutReady) void windowLayoutReady.then(mount)
else mount()

import './styles/collections.css'
import './shared/video-result.css'
import './styles/downloads.css'

import './styles/mobile-pages.css'

import './styles/media-features.css'

import './styles/queue.css'
import './styles/playlist-import.css'

import './styles/recommendations.css'
import './styles/mini-player.css'
import './styles/playback-cache.css'
import './styles/search-suggestions.css'
import './styles/editor-polish.css'

import './styles/list-toolbar.css'

import './styles/interaction-motion.css'
import './styles/tablet.css'
import './styles/controls.css'
import './features/chapters/chapters.css'
import './features/comments/chapterEditor.css'

import './features/settings/diagnostics.css'
