import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { flushSync } from 'react-dom'
import { create } from 'zustand'
import {
  nextThemePreference,
  parseThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemePreference,
} from '../domain/theme'
import { subscribeMediaQuery } from '../shared/subscribeMediaQuery'
import { isAndroid, isIOS, isOHOS } from './platform'

export type { Theme, ThemePreference } from '../domain/theme'

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> }
}

/** WebViews that cannot resolve the OS colour scheme answer `not all`. */
function systemQuery(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
  try {
    return window.matchMedia('(prefers-color-scheme: dark)')
  } catch {
    return undefined
  }
}

let systemSupported: boolean | undefined
/** Resolved once: a WebView either understands the media query for its whole life. */
export function systemThemeSupported(): boolean {
  if (systemSupported === undefined) {
    const query = systemQuery()
    systemSupported = Boolean(query && query.media !== 'not all')
  }
  return systemSupported
}

function systemTheme(): Theme {
  const query = systemQuery()
  return query && query.media !== 'not all' && query.matches ? 'dark' : 'light'
}

/** `system` is meaningless where the media query cannot answer, so it degrades to dark. */
function usablePreference(preference: ThemePreference): ThemePreference {
  return preference === 'system' && !systemThemeSupported() ? 'dark' : preference
}

function readPreference(): ThemePreference {
  try {
    return usablePreference(parseThemePreference(typeof localStorage === 'undefined' ? undefined : localStorage.getItem(THEME_STORAGE_KEY)))
  } catch {
    return 'dark'
  }
}

const initialPreference = readPreference()
const initialTheme: Theme = resolveTheme(initialPreference, systemTheme())
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

/** Re-reads the OS scheme and corrects the page. Used by the media query and by the
 * desktop window hand-back, which can change the WebView scheme without a change event. */
function resyncWithSystem() {
  const state = useThemeStore.getState()
  if (state.preference !== 'system') return
  const next = systemTheme()
  if (next !== state.theme) commitTheme(next, 'system', false)
}

function applyTheme(theme: Theme, preference: ThemePreference) {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f6fa' : '#071019')
  }
  const light = theme === 'light' ? 1 : 0
  if (isOHOS) void invoke('plugin:ohos-player|control', { action: 'theme', value: light }).catch(() => undefined)
  else if (isAndroid) void invoke('plugin:android-player|control', { action: 'theme', value: light }).catch(() => undefined)
  else if (isIOS) void invoke('plugin:ios-player|control', { action: 'theme', value: light }).catch(() => undefined)
  else if (isTauri()) {
    // Desktop windows take their frame colour from here; null hands it back to the OS.
    void getCurrentWindow().setTheme(preference === 'system' ? null : theme)
      .then(() => { if (preference === 'system') resyncWithSystem() })
      .catch(() => undefined)
  }
}

function canAnimateTheme(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (document.visibilityState === 'hidden') return false
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  return true
}

/** Applies a resolved theme with the light/dark wipe, or instantly when it cannot animate. */
function commitTheme(next: Theme, preference: ThemePreference, animate: boolean) {
  const previous = useThemeStore.getState().theme
  if (!animate || previous === next || !canAnimateTheme()) {
    clearTransitionArtifacts()
    applyTheme(next, preference)
    useThemeStore.setState({ theme: next, preference })
    return
  }
  const seq = ++activeTransitionSeq
  clearTransitionArtifacts()
  const doc = document as ViewTransitionDocument
  const finish = () => {
    if (seq === activeTransitionSeq) clearTransitionArtifacts()
  }
  if (typeof doc.startViewTransition === 'function') {
    document.documentElement.dataset.themeTransition = next
    try {
      let beam: HTMLDivElement | undefined
      const transition = doc.startViewTransition(() => {
        beam = document.createElement('div')
        beam.id = 'theme-wipe-beam'
        beam.className = 'theme-wipe-beam'
        beam.dataset.target = next
        beam.setAttribute('aria-hidden', 'true')
        document.body?.appendChild(beam)
        applyTheme(next, preference)
        flushSync(() => useThemeStore.setState({ theme: next, preference }))
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
  applyTheme(next, preference)
  useThemeStore.setState({ theme: next, preference })
  cleanupTimer = setTimeout(finish, 320)
}

export const useThemeStore = create<{ theme: Theme; preference: ThemePreference; setTheme: (preference: ThemePreference) => void; cycleTheme: () => void }>((set, get) => ({
  theme: initialTheme,
  preference: initialPreference,
  setTheme: (requested) => {
    const preference = usablePreference(requested)
    try { localStorage.setItem(THEME_STORAGE_KEY, preference) } catch { /* Theme can still change when storage is unavailable. */ }
    set({ preference })
    commitTheme(resolveTheme(preference, systemTheme()), preference, true)
  },
  cycleTheme: () => get().setTheme(nextThemePreference(get().preference, systemThemeSupported())),
}))

applyTheme(initialTheme, initialPreference)

// While following the system, follow it live. Other preferences ignore the OS.
if (systemThemeSupported()) {
  const query = systemQuery()
  if (query) subscribeMediaQuery(query, resyncWithSystem)
}
