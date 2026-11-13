import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { commandErrorMessage } from '../../services/desktopApi'
import { floatingCapability, setFloatingLyrics, useFloatingLyrics, type FloatingCapability } from '../../services/floatingLyrics'

export function FloatingLyricsToggle() {
  const { enabled, busy } = useFloatingLyrics()
  const [capability, setCapability] = useState<FloatingCapability | null>(null)
  useEffect(() => {
    let alive = true
    void floatingCapability().then(value => { if (alive) setCapability(value) })
      .catch(cause => { if (alive) setCapability({ supported:false,enabled:false,reason:commandErrorMessage(cause) }) })
    return () => { alive = false }
  }, [])
  const label = enabled ? '关闭悬浮歌词' : '开启悬浮歌词'
  return <button type="button" className="floating-lyrics-toggle" aria-label={label} aria-pressed={enabled} aria-busy={busy}
    title={capability && !capability.supported ? capability.reason || '此系统暂不支持悬浮歌词' : label}
    disabled={busy || !capability?.supported} onClick={() => void setFloatingLyrics(!enabled)}>
    <span className="floating-lyrics-icon" aria-hidden="true">{busy ? <LoaderCircle size={13} className="spin"/> : '词'}</span>
  </button>
}
