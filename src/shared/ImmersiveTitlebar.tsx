import { Minus, Square, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { desktopFrame } from '../services/immersiveWindow'

export function ImmersiveTitlebar({ onError }: { onError: (error: unknown) => void }) {
  if (desktopFrame === 'browser') return null
  return <div className={`immersive-titlebar ${desktopFrame}`} data-tauri-drag-region>
    {desktopFrame === 'windows' && <>
      <span data-tauri-drag-region>BiliMusic</span>
      <div className="immersive-window-controls">
        <button aria-label="最小化窗口" title="最小化" onDoubleClick={(event) => event.stopPropagation()} onClick={() => void getCurrentWindow().minimize().catch(onError)}><Minus size={15} /></button>
        <button aria-label="最大化或还原窗口" title="最大化 / 还原" onDoubleClick={(event) => event.stopPropagation()} onClick={() => void getCurrentWindow().toggleMaximize().catch(onError)}><Square size={12} /></button>
        <button className="window-close" aria-label="关闭窗口" title="关闭窗口" onDoubleClick={(event) => event.stopPropagation()} onClick={() => void getCurrentWindow().close().catch(onError)}><X size={16} /></button>
      </div>
    </>}
  </div>
}
