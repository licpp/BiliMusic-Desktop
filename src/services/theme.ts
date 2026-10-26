import { create } from 'zustand'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

export type Theme = 'dark' | 'light'
const initial: Theme = localStorage.getItem('bilimusic-theme') === 'light' ? 'light' : 'dark'
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f6fa' : '#071019')
  if (isTauri()) void getCurrentWindow().setTheme(theme).catch(() => undefined)
}
export const useThemeStore = create<{ theme: Theme; setTheme: (theme: Theme) => void }>((set) => ({
  theme: initial,
  setTheme: (theme) => { try { localStorage.setItem('bilimusic-theme', theme) } catch { /* Theme can still change when storage is unavailable. */ } applyTheme(theme); set({ theme }) },
}))
applyTheme(initial)
