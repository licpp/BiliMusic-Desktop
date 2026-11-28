// Desktop window chrome rules. The shell renders custom controls because the
// main window is frameless; keeping the order, side and labels here lets the
// platform variants stay testable without a WebView.

export type DesktopPlatform = 'windows' | 'macos' | 'linux'
export type WindowControl = 'minimize' | 'toggle-maximize' | 'close'

/** Desktop UAs only; iPadOS is handled by `isMobile` before this runs. */
export function desktopPlatform(userAgent: string): DesktopPlatform {
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos'
  if (/Linux/i.test(userAgent) && !/Android/i.test(userAgent)) return 'linux'
  return 'windows'
}

/** macOS keeps its traffic lights on the left; Windows and Linux put them right. */
export function windowControlsOnLeft(platform: DesktopPlatform): boolean {
  return platform === 'macos'
}

/**
 * Left-to-right order inside the control cluster. macOS reads
 * close/minimise/zoom like its native buttons; the others read
 * minimise/maximise/close.
 */
export function windowControlOrder(platform: DesktopPlatform): readonly WindowControl[] {
  return windowControlsOnLeft(platform)
    ? ['close', 'minimize', 'toggle-maximize']
    : ['minimize', 'toggle-maximize', 'close']
}

export function windowControlLabel(action: WindowControl, maximized = false): string {
  switch (action) {
    case 'minimize':
      return '最小化'
    case 'close':
      return '关闭'
    case 'toggle-maximize':
      return maximized ? '还原窗口' : '最大化窗口'
  }
}
