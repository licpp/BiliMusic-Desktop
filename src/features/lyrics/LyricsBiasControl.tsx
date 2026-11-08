import { useEffect, useRef } from 'react'
import { Clock3, X } from 'lucide-react'

function Step({ delta, onAdjust, disabled }: { delta: number; onAdjust: (delta: number) => void; disabled: boolean }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const interval = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const adjust = useRef(onAdjust)
  adjust.current = onAdjust
  const stop = () => { clearTimeout(timer.current); clearInterval(interval.current) }
  useEffect(() => stop, [])
  return <button type="button" className="bias-step" disabled={disabled} title={`歌词${delta < 0 ? '提前' : '延后'} 0.5 秒`} aria-label={`歌词${delta < 0 ? '提前' : '延后'} 0.5 秒`} onPointerDown={event => {
    if (!event.isPrimary || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus({ preventScroll: true })
    stop(); adjust.current(delta)
    timer.current = setTimeout(() => { interval.current = setInterval(() => adjust.current(delta), 140) }, 400)
  }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onBlur={stop}
  onClick={event => { if (event.detail === 0) adjust.current(delta) }}>
    {delta < 0 ? '−' : '＋'}
  </button>
}

export function LyricsBiasControl({ value, enabled, error, onAdjust, onClose, onActivity }: {
  value: number; enabled: boolean; error: boolean
  onAdjust: (delta: number) => void; onClose: () => void; onActivity: () => void
}) {
  return <aside className="lyrics-bias expanded" aria-label="歌词时间调整" onPointerDown={onActivity} onKeyDown={onActivity}>
    <button type="button" className="bias-trigger" aria-label="关闭歌词时间调整" title="关闭" onClick={onClose}><X size={16}/></button>
    <Step delta={500} onAdjust={onAdjust} disabled={!enabled}/>
    <output aria-live="polite" className={error ? 'bias-save-error' : undefined} title={error ? '偏移保存失败，请重试' : '点选歌词可对齐到当前播放'}>{value > 0 ? '+' : ''}{(value / 1000).toFixed(1)}s</output>
    <Step delta={-500} onAdjust={onAdjust} disabled={!enabled}/>
    <button type="button" className="bias-reset" disabled={!enabled} aria-label={error ? '重试保存歌词偏移' : '重置歌词偏移'} title={error ? '保存失败，点击重试' : '重置偏移'} onClick={() => onAdjust(error ? 0 : -value)}><Clock3 size={14}/></button>
  </aside>
}
