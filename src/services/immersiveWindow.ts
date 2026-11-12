import { isTauri, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isAndroid, isIOS, isMobile } from './platform'

export const desktopFrame = isTauri() && !isMobile
  ? /Windows/i.test(navigator.userAgent) ? 'windows' : /Macintosh|Mac OS X/i.test(navigator.userAgent) ? 'macos' : 'browser'
  : 'browser'
let appearance = Promise.resolve()
export const miniPlayerSupported = !isMobile && (isTauri() || import.meta.env.DEV)
export async function getMiniPlayerMode(): Promise<boolean> {
  return isTauri() && !isMobile ? invoke<boolean>('desktop_mini_state') : false
}
export function setMiniPlayerMode(enabled: boolean): Promise<boolean> {
  const transition = appearance.catch(() => undefined).then(() => isTauri() && !isMobile ? invoke<boolean>('desktop_mini_set', { enabled }) : enabled)
  appearance = transition.then(() => undefined)
  return transition
}
export function setMiniPlayerPanel(expanded: boolean): Promise<void> {
  const transition = appearance.catch(() => undefined).then(() => isTauri() && !isMobile ? invoke<void>('desktop_mini_panel', { expanded }) : undefined)
  appearance = transition.then(() => undefined)
  return transition
}
export function setImmersiveWindow(active: boolean) {
  // Serialize native frame changes so a quick open/close always restores the frame.
  appearance = appearance.catch(() => undefined).then(async () => {
    if (isAndroid) await invoke('plugin:android-player|control', { action: 'immersive', value: active ? 1 : 0 })
    else if (isIOS) await invoke('plugin:ios-player|control', { action: 'immersive', value: active ? 1 : 0 })
    else if (desktopFrame === 'macos') await getCurrentWindow().setTitleBarStyle(active ? 'overlay' : 'visible')
    else if (desktopFrame === 'windows') await getCurrentWindow().setDecorations(!active)
  })
  return appearance
}
