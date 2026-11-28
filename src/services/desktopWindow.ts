import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow, type Window } from '@tauri-apps/api/window'
import { desktopPlatform, type DesktopPlatform } from '../domain/windowChrome'
import { isMobile } from './platform'

/**
 * The custom titlebar belongs to the desktop shell only. Dev browser runs keep
 * it visible so the E2E scenario can drive the real DOM; the window commands
 * themselves stay disabled until Tauri is present.
 */
export const desktopChrome = !isMobile
export const desktopChromePlatform: DesktopPlatform = desktopPlatform(
  typeof navigator === 'undefined' ? '' : navigator.userAgent,
)
const nativeDesktop = isTauri() && !isMobile

function mainWindow(): Window | undefined {
  return nativeDesktop ? getCurrentWindow() : undefined
}

export function minimizeMainWindow(): Promise<void> {
  return mainWindow()?.minimize() ?? Promise.resolve()
}

export function toggleMaximizeMainWindow(): Promise<void> {
  return mainWindow()?.toggleMaximize() ?? Promise.resolve()
}

export function closeMainWindow(): Promise<void> {
  return mainWindow()?.close() ?? Promise.resolve()
}

/**
 * Reports the maximised state now and whenever the window is resized. The
 * returned cleanup also drops a listener that resolves after unmount, so
 * switching into the mini player cannot leave a late callback behind.
 */
export function watchMaximized(handler: (maximized: boolean) => void): () => void {
  const target = mainWindow()
  if (!target) {
    handler(false)
    return () => undefined
  }
  let active = true
  let unlisten: (() => void) | undefined
  const sync = () => {
    void target.isMaximized()
      .then(value => { if (active) handler(value) })
      .catch(() => undefined)
  }
  sync()
  void target.onResized(sync)
    .then(stop => { if (active) unlisten = stop; else stop() })
    .catch(() => undefined)
  return () => {
    active = false
    unlisten?.()
    unlisten = undefined
  }
}
