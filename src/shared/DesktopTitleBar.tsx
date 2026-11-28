import { useEffect, useState, type ReactNode } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import {
  windowControlLabel,
  windowControlOrder,
  type WindowControl,
} from '../domain/windowChrome'
import {
  closeMainWindow,
  desktopChromePlatform,
  minimizeMainWindow,
  toggleMaximizeMainWindow,
  watchMaximized,
} from '../services/desktopWindow'

function runWindowControl(action: WindowControl) {
  if (action === 'minimize') void minimizeMainWindow().catch(() => undefined)
  else if (action === 'close') void closeMainWindow().catch(() => undefined)
  else void toggleMaximizeMainWindow().catch(() => undefined)
}

function controlIcon(action: WindowControl, maximized: boolean) {
  if (action === 'minimize') return <Minus size={16} />
  if (action === 'close') return <X size={16} />
  return maximized ? <Copy size={13} /> : <Square size={12} />
}

/**
 * Frameless desktop shell header. It is the app's only top bar: the brand,
 * the search/navigation row and the window controls share one strip, like the
 * reference design. Draggable fillers sit between those pieces; no control is
 * inside a drag region, so a click never turns into a drag.
 */
export function DesktopTitleBar({
  children,
  onBrandClick,
  inert = false,
}: {
  children?: ReactNode
  onBrandClick?: () => void
  /** True while a dialog owns the page; the header content stops taking input. */
  inert?: boolean
}) {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => watchMaximized(setMaximized), [])
  const platform = desktopChromePlatform
  return (
    <header
      className="desktop-titlebar"
      data-desktop-titlebar=""
      data-platform={platform}
      data-maximized={maximized ? 'true' : undefined}
    >
      <button type="button" className="desktop-titlebar-brand" aria-label="BiliMusic 首页" onClick={onBrandClick}>
        <span className="desktop-titlebar-logo">
          <img src="/app-icon.png" alt="" draggable={false} />
        </span>
        <span className="desktop-titlebar-wordmark">BiliMusic</span>
      </button>
      <div className="desktop-titlebar-drag" data-tauri-drag-region aria-hidden="true" />
      <div className="desktop-titlebar-body" inert={inert || undefined}>
        {children}
      </div>
      <div className="desktop-window-controls" role="group" aria-label="窗口控制">
        {windowControlOrder(platform).map(action => {
          const label = windowControlLabel(action, maximized)
          return (
            <button
              type="button"
              key={action}
              className="desktop-window-control"
              data-window-control={action}
              aria-label={label}
              title={label}
              onClick={() => runWindowControl(action)}
            >
              <span className="desktop-window-control-glyph" aria-hidden="true">
                {controlIcon(action, maximized)}
              </span>
            </button>
          )
        })}
      </div>
    </header>
  )
}
