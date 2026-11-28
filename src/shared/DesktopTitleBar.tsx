import { useEffect, useState } from 'react'
import { Copy, Minus, Square, Waves, X } from 'lucide-react'
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
 * Frameless desktop shell header. The whole bar drags the window through
 * `data-tauri-drag-region`; the controls sit outside that region so a click
 * never turns into a drag. Double-clicking the bar restores or maximises.
 */
export function DesktopTitleBar() {
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
      <div className="desktop-titlebar-brand" data-tauri-drag-region>
        <Waves size={15} strokeWidth={2.4} aria-hidden="true" />
        <span>BiliMusic</span>
      </div>
      <div className="desktop-titlebar-drag" data-tauri-drag-region aria-hidden="true" />
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
