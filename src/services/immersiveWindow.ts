import { isTauri, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isAndroid, isIOS, isMobile, isOHOS } from './platform'

export const desktopFrame = isTauri() && !isMobile
  ? /Windows/i.test(navigator.userAgent) ? 'windows' : /Macintosh|Mac OS X/i.test(navigator.userAgent) ? 'macos' : 'browser'
  : 'browser'
let appearance = Promise.resolve()

const insetSides = ['top', 'right', 'bottom', 'left'] as const
type OHOSWindowInsets = { active: boolean } & Record<(typeof insetSides)[number], number>

function applyOHOSInsets(insets: OHOSWindowInsets) {
  const root = document.documentElement
  root.toggleAttribute('data-ohos-edge-to-edge', insets.active === true)
  for (const side of insetSides) {
    const property = `--native-safe-${side}`
    const offset = insets[side]
    if (insets.active && Number.isFinite(offset)) {
      root.style.setProperty(property, `${Math.max(0, offset)}px`)
    } else {
      root.style.removeProperty(property)
    }
  }
}

export function installOHOSWindowInsets(): Promise<void> {
  const viewport = window.visualViewport
  let revision = 0
  let timer: number | undefined
  const read = async (request: number) => {
    const insets = await invoke<OHOSWindowInsets>('plugin:ohos-player|control', { action: 'windowInsets' }).catch(() => undefined)
    if (insets && revision === request) applyOHOSInsets(insets)
  }
  const refresh = () => {
    const request = ++revision
    window.clearTimeout(timer)
    if (document.hidden) return
    // Avoid areas can settle after ArkWeb reports the new viewport size.
    timer = window.setTimeout(() => void read(request), 80)
  }
  window.addEventListener('resize', refresh)
  viewport?.addEventListener('resize', refresh)
  document.addEventListener('visibilitychange', refresh)
  return read(revision)
}

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
export function setImmersiveWindow(active: boolean, keepSystemInsets = false) {
  if (isOHOS) return Promise.resolve()
  // Serialize native frame changes so a quick open/close always restores the frame.
  appearance = appearance.catch(() => undefined).then(async () => {
    if (isAndroid) await invoke('plugin:android-player|control', { action: 'immersive', value: active ? 1 : 0, keepSystemInsets })
    else if (isIOS) await invoke('plugin:ios-player|control', { action: 'immersive', value: active ? 1 : 0 })
    else if (desktopFrame === 'macos') await getCurrentWindow().setTitleBarStyle(active ? 'overlay' : 'visible')
    else if (desktopFrame === 'windows') await getCurrentWindow().setDecorations(!active)
  })
  return appearance
}
