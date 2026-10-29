import { isTauri, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isAndroid } from './platform'

export const desktopFrame = isTauri() && !isAndroid
  ? /Windows/i.test(navigator.userAgent) ? 'windows' : /Macintosh|Mac OS X/i.test(navigator.userAgent) ? 'macos' : 'browser'
  : 'browser'
let appearance = Promise.resolve()
export function setImmersiveWindow(active: boolean) {
  // Serialize native frame changes so a quick open/close always restores the frame.
  appearance = appearance.catch(() => undefined).then(async () => {
    if (isAndroid) await invoke('plugin:android-player|control', { action: 'immersive', value: active ? 1 : 0 })
    else if (desktopFrame === 'macos') await getCurrentWindow().setTitleBarStyle(active ? 'overlay' : 'visible')
    else if (desktopFrame === 'windows') await getCurrentWindow().setDecorations(!active)
  })
  return appearance
}
