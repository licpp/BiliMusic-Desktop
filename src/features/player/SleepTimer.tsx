import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock3, ChevronRight } from 'lucide-react'
import { commandErrorMessage } from '../../services/desktopApi'
import { formatDuration } from '../../shared/time'
import { isMobile } from '../../services/platform'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { controlMobileAudio } from './mobileAudio'
import { controlDesktopSleep, usePlayerStore } from './playerStore'

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
  const action = async (command: Parameters<typeof controlDesktopSleep>[0], value?: number) => {
    setError(''); setBusy(true)
    try { await (isMobile ? controlMobileAudio(command, value) : controlDesktopSleep(command, value)); onClose() }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  if (!open && !sleep.expired) return null

  if (sleep.expired) return createPortal(
    <section className="sleep-timer-notice" role="region" aria-label="定时暂停已到期">
      <Clock3 size={20}/><div><strong>播放已定时暂停</strong><small>{Math.round(sleep.duration / 60)} 分钟已到</small></div>
      <button disabled={busy} onClick={() => void action('sleepDismiss')}>关闭</button>
      <button disabled={busy} onClick={() => void action('sleepRepeat')}>重复</button>
      {error && <small role="alert">{error}</small>}
    </section>, document.body)
  return <CollectionDialog title="定时暂停" className="sleep-timer-settings" onClose={onClose}>
    {sleep.deadline > 0 && <p>剩余 {formatDuration(Math.max(0, Math.ceil((sleep.deadline - now) / 1000)))}</p>}
    <div className="sleep-timer-presets">{durations.map(value => <button key={value} aria-pressed={minutes === value} onClick={() => setMinutes(value)}>{value} 分钟</button>)}</div>
    <form className="sleep-timer-custom" onSubmit={event => { event.preventDefault(); if (!busy && minutes >= 1 && minutes <= 180 && Number.isInteger(minutes)) void action('sleepStart', minutes * 60) }}>
      <label>自定时长 <input type="number" inputMode="numeric" min={1} max={180} value={minutes || ''} onChange={event => setMinutes(Number(event.target.value))}/> 分钟</label>
      <button className="mobile-page-primary" disabled={busy || !Number.isInteger(minutes) || minutes < 1 || minutes > 180}>{sleep.deadline > 0 ? '重新计时' : '开始计时'}</button>
    </form>
    {error && <small role="alert">{error}</small>}
    {sleep.deadline > 0 && <footer><button disabled={busy} onClick={() => void action('sleepCancel')}>取消定时</button></footer>}
  </CollectionDialog>
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
