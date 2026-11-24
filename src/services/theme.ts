import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { flushSync } from 'react-dom'
import { create } from 'zustand'
import { isAndroid, isIOS, isOHOS } from './platform'

export type Theme = 'dark' | 'light'

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> }
}

function readInitialTheme(): Theme {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('bilimusic-theme') === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

const initial: Theme = readInitialTheme()
let cleanupTimer: ReturnType<typeof setTimeout> | undefined
let activeTransitionSeq = 0

function clearTransitionArtifacts() {
  if (cleanupTimer !== undefined) {
    clearTimeout(cleanupTimer)
    cleanupTimer = undefined
  }
  if (typeof document === 'undefined') return
  delete document.documentElement.dataset.themeTransition
  document.getElementById('theme-wipe-beam')?.remove()
}

function applyTheme(theme: Theme) {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f6fa' : '#071019')
  }
  if (isOHOS) void invoke('plugin:ohos-player|control', { action: 'theme', value: theme === 'light' ? 1 : 0 }).catch(() => undefined)
  else if (isAndroid) void invoke('plugin:android-player|control', { action: 'theme', value: theme === 'light' ? 1 : 0 }).catch(() => undefined)
  else if (isIOS) void invoke('plugin:ios-player|control', { action: 'theme', value: theme === 'light' ? 1 : 0 }).catch(() => undefined)
  else if (isTauri()) void getCurrentWindow().setTheme(theme).catch(() => undefined)
}

function canAnimateTheme(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (document.visibilityState === 'hidden') return false
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  return true
}

export const useThemeStore = create<{ theme: Theme; setTheme: (theme: Theme) => void }>((set, get) => ({
  theme: initial,
  setTheme: (theme) => {
    const previous = get().theme
    try { localStorage.setItem('bilimusic-theme', theme) } catch { /* Theme can still change when storage is unavailable. */ }
    if (previous === theme || !canAnimateTheme()) {
      clearTransitionArtifacts()
      applyTheme(theme)
      set({ theme })
      return
    }
    const seq = ++activeTransitionSeq
    clearTransitionArtifacts()
    const doc = document as ViewTransitionDocument
    const finish = () => {
      if (seq === activeTransitionSeq) clearTransitionArtifacts()
    }
    if (typeof doc.startViewTransition === 'function') {
      document.documentElement.dataset.themeTransition = theme
      try {
        let beam: HTMLDivElement | undefined
        const transition = doc.startViewTransition(() => {
          beam = document.createElement('div')
          beam.id = 'theme-wipe-beam'
          beam.className = 'theme-wipe-beam'
          beam.dataset.target = theme
          beam.setAttribute('aria-hidden', 'true')
          document.body?.appendChild(beam)
          applyTheme(theme)
          flushSync(() => set({ theme }))
        })
        void transition.ready?.then(() => { if (beam) beam.style.opacity = '0' }, () => undefined)
        void transition.finished.then(finish, finish)
        cleanupTimer = setTimeout(finish, 900)
        return
      } catch {
        clearTransitionArtifacts()
      }
    }
    document.documentElement.dataset.themeTransition = 'fallback'
    applyTheme(theme)
    set({ theme })
    cleanupTimer = setTimeout(finish, 320)
  },
}))
applyTheme(initial)
