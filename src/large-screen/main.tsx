import '../shared/runtimeCompatibility'
import 'core-js/es/array/flat'
import 'core-js/es/array/flat-map'
import 'core-js/es/global-this'
import 'core-js/es/object/from-entries'
import 'core-js/es/promise/all-settled'
import 'core-js/es/promise/finally'
import 'core-js/es/string/match-all'
import 'core-js/web/queue-microtask'
import '../styles/components/content-visibility.css'
import { startFloatingLyrics } from '../services/floatingLyrics'
import { startUpdateChecks } from '../services/updates'
import { installAccountQueryScope } from '../services/queryKeys'
import { installLocalPlayback } from '../app/localPlayback'
import { StrictMode, useEffect } from 'react'
import { installStartupDiagnostics } from '../services/diagnostics'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { startCloudSync } from '../services/sync'
import { startAutomaticLyrics } from '../features/lyrics/automaticLyrics'
import { startListeningStatistics } from '../services/listeningStatistics'
import { startPreloadingNextTrack } from '../features/player/preloadNextTrack'
import { startCreatorQueue } from '../services/creatorQueue'
import { SubtitleController } from '../features/lyrics/useBiliSubtitles'
import { isAndroid } from '../services/platform'
import { installOverlayBack } from '../shared/overlayStack'
import { installMobileKeyboard } from '../shared/mobileKeyboard'
import { controlMobileAudio } from '../features/player/mobileAudio'
import { LargeScreenApp } from './LargeScreenApp'
import { dismissLargeKeyboard } from './keyboard'
import '../styles/global.css'
import '../styles/theme.css'
import '../styles/collections.css'
import '../styles/media-features.css'
import '../styles/playback-cache.css'
import '../styles/editor-polish.css'
import './large-screen.css'
import '../features/settings/diagnostics.css'

document.documentElement.dataset.layout = 'large'
document.documentElement.style.setProperty('--large-scale', String([0.9, 1, 1.15].includes(Number(localStorage.getItem('large-ui-size'))) ? Number(localStorage.getItem('large-ui-size')) : 1))
document.documentElement.style.setProperty('--large-lyric-scale', String([0.85, 1, 1.2].includes(Number(localStorage.getItem('large-lyrics-size'))) ? Number(localStorage.getItem('large-lyrics-size')) : 1))
document.documentElement.dataset.platform = isAndroid ? 'android' : 'desktop'
installMobileKeyboard({ scrollContainers: '.large-dialog,.large-main', topInset: 58, onDismiss: dismissLargeKeyboard })
installOverlayBack()
if (isAndroid) void controlMobileAudio('largeScreen', 1).catch(() => undefined)
const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } })
const diagnoseReady = installStartupDiagnostics()
function DiagnosticBoot() { useEffect(diagnoseReady, []); return null }
installAccountQueryScope(client)
installLocalPlayback(client)
startUpdateChecks()
startCloudSync(client)
startAutomaticLyrics()
startFloatingLyrics()
startListeningStatistics()
startPreloadingNextTrack()
startCreatorQueue()
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={client}><SubtitleController/><LargeScreenApp/><DiagnosticBoot/></QueryClientProvider></StrictMode>)
