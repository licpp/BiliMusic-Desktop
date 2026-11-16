import type { NativeControlAction } from '../features/player/contracts'
import { useEffect, useState } from 'react'
import { usePlayerStore } from '../features/player/playerStore'
import { controlMobileAudio } from '../features/player/mobileAudio'
import { commandErrorMessage } from '../services/desktopApi'
import { formatDuration } from '../shared/time'
import { LargeDialog } from './LargeDialog'

export function LargeSleep({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sleep = usePlayerStore(s => s.sleep), [minutes, setMinutes] = useState(30), [busy, setBusy] = useState(false), [error, setError] = useState(''), [now, setNow] = useState(Date.now())
  useEffect(() => { if (!open || !sleep.deadline) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [open, sleep.deadline])
  const action = async (command: NativeControlAction, value = 0) => { setBusy(true); setError(''); try { await controlMobileAudio(command, value); onClose() } catch (e) { setError(commandErrorMessage(e)) } finally { setBusy(false) } }
  if (!open && !sleep.expired) return null
  return <LargeDialog title={sleep.expired ? '播放已定时暂停' : '定时暂停'} onClose={() => { if (sleep.expired) void action('sleepDismiss'); else onClose() }}>
    {sleep.expired ? <div className="large-options"><button disabled={busy} onClick={() => void action('sleepDismiss')}>关闭</button><button disabled={busy} onClick={() => void action('sleepRepeat')}>再听 {Math.round(sleep.duration / 60)} 分钟</button></div> : <>
      {sleep.deadline > 0 && <p className="large-muted">剩余 {formatDuration(Math.max(0, (sleep.deadline - now) / 1000))}</p>}
      <div className="large-options">{[15, 30, 45, 60, 90].map(m => <button key={m} disabled={busy} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>{m} 分钟</button>)}</div>
      <div className="large-options" style={{ marginTop: 22 }}><button className="large-primary" disabled={busy} onClick={() => void action('sleepStart', minutes * 60)}>{sleep.deadline ? '重新计时' : '开始计时'}</button>{sleep.deadline > 0 && <button disabled={busy} onClick={() => void action('sleepCancel')}>取消定时</button>}</div>
    </>}{error && <p className="large-error" role="alert">{error}</p>}
  </LargeDialog>
}
