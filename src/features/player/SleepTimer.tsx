import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock3, X, ChevronRight } from 'lucide-react'
import { commandErrorMessage } from '../../services/desktopApi'
import { formatDuration } from '../../shared/time'
import { controlMobileAudio } from './mobileAudio'
import { usePlayerStore } from './playerStore'

const durations = [15, 30, 45, 60]

export function SleepTimer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sleep = usePlayerStore(state => state.sleep)
  const [minutes, setMinutes] = useState(30)
  const [now, setNow] = useState(Date.now)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open || !sleep.deadline) return
    setNow(Date.now())
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [open, sleep.deadline])
  const action = async (command: string, value?: number) => {
    setError(''); setBusy(true)
    try { await controlMobileAudio(command, value); onClose() }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  if (!open && !sleep.expired) return null

  return createPortal(sleep.expired ?
    <section className="sleep-timer-notice" role="alertdialog" aria-label="定时暂停已到期">
      <Clock3 size={20}/><div><strong>播放已定时暂停</strong><small>{Math.round(sleep.duration / 60)} 分钟已到</small></div>
      <button disabled={busy} onClick={() => void action('sleepDismiss')}>关闭</button>
      <button disabled={busy} onClick={() => void action('sleepRepeat')}>重复</button>
      {error && <small role="alert">{error}</small>}
    </section> : <div className="dialog-backdrop sleep-timer-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="sleep-timer-settings" role="dialog" aria-modal="true" aria-label="定时暂停">
        <header><h3>定时暂停</h3><button className="icon-action" aria-label="关闭" onClick={onClose}><X size={19}/></button></header>
        {sleep.deadline > 0 && <p>剩余 {formatDuration(Math.max(0, Math.ceil((sleep.deadline - now) / 1000)))}</p>}
        <div className="sleep-timer-presets">{durations.map(value => <button key={value} aria-pressed={minutes === value} onClick={() => setMinutes(value)}>{value} 分钟</button>)}</div>
        <label>自定时长 <input type="number" inputMode="numeric" min={1} max={180} value={minutes || ''} onChange={event => setMinutes(Number(event.target.value))}/> 分钟</label>
        {error && <small role="alert">{error}</small>}
        <footer>{sleep.deadline > 0 && <button disabled={busy} onClick={() => void action('sleepCancel')}>取消定时</button>}
          <button className="mobile-page-primary" disabled={busy || !Number.isInteger(minutes) || minutes < 1 || minutes > 180} onClick={() => void action('sleepStart', minutes * 60)}>{sleep.deadline > 0 ? '重新计时' : '开始计时'}</button></footer>
      </section>
    </div>, document.body)
}

export function SleepTimerEntry({ onOpen }: { onOpen: () => void }) {
  const deadline = usePlayerStore(state => state.sleep.deadline)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!deadline) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [deadline])
  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000))
  return <button type="button" className="sleep-timer-entry" onClick={onOpen}>
    <Clock3 size={18}/><span>定时暂停</span><small>{deadline > 0 ? formatDuration(remaining) : '未开启'}</small><ChevronRight size={16}/>
  </button>
}
