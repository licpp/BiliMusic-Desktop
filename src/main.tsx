import { startCloudSync } from './services/sync'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './app/App'
import { isAndroid, isIOS } from './services/platform'
import { installMobileGestures } from './shared/mobileGestures'
import { startAutomaticLyrics } from './features/lyrics/automaticLyrics'
import './styles/global.css'
import './styles/theme.css'
import './styles/mobile.css'
import './styles/immersive.css'
import './styles/comments.css'

document.documentElement.dataset.platform = isIOS ? 'ios' : isAndroid ? 'android' : 'desktop'
installMobileGestures()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

startCloudSync(queryClient)
startAutomaticLyrics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)

import './styles/collections.css'
import './styles/downloads.css'
