import { useEffect, useRef } from 'react'
import { RotateCcw, X } from 'lucide-react'

function Step({ delta, onAdjust, disabled }: { delta: number; onAdjust: (delta: number) => void; disabled: boolean }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const interval = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const adjust = useRef(onAdjust)
  adjust.current = onAdjust
  const stop = () => { clearTimeout(timer.current); clearInterval(interval.current) }
  useEffect(() => stop, [])
  return <button type="button" disabled={disabled} onPointerDown={event => {
    if (!event.isPrimary || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus({ preventScroll: true })
    stop(); adjust.current(delta)
    timer.current = setTimeout(() => { interval.current = setInterval(() => adjust.current(delta), 140) }, 400)
  }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onBlur={stop}
  onClick={event => { if (event.detail === 0) adjust.current(delta) }}>
    <span aria-hidden="true">{delta < 0 ? '−' : '＋'}</span>歌词{delta < 0 ? '提前' : '延后'}<small>0.5 秒</small>
  </button>
}

export function LyricsBiasControl({ value, enabled, error, onAdjust, onClose, onActivity }: {
  value: number; enabled: boolean; error: boolean
  onAdjust: (delta: number) => void; onClose: () => void; onActivity: () => void
}) {
  return <aside className="lyrics-bias expanded" aria-label="歌词时间调整" onPointerDown={onActivity} onKeyDown={onActivity}>
    <header><strong>调整歌词时间</strong><button className="bias-trigger" aria-label="关闭歌词时间调整" onClick={onClose}><X size={18}/></button></header>
    <output aria-live="polite">{value === 0 ? '与原歌词时间一致' : `歌词${value < 0 ? '提前' : '延后'} ${(Math.abs(value) / 1000).toFixed(1)} 秒`}</output>
    <div className="bias-steps"><Step delta={-500} onAdjust={onAdjust} disabled={!enabled}/><Step delta={500} onAdjust={onAdjust} disabled={!enabled}/></div>
    <p>{enabled ? '歌词慢了选提前，快了选延后。也可点选歌词，将那一句对齐到现在。' : '这份歌词没有时间标记，无法调整。'}</p>
    <footer><span>{error ? '保存失败，请重试' : '实时预览 · 自动保存'}</span><button disabled={!enabled} onClick={() => onAdjust(error ? 0 : -value)}><RotateCcw size={14}/>{error ? '重试保存' : '重置'}</button></footer>
  </aside>
}
