import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ArrowUpRight, Pause, Play, Power, SkipBack, SkipForward } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Artwork } from '../../shared/Artwork'
import { formatDuration } from '../../shared/time'
import '../../styles/tray-player.css'

type Snapshot = {
  id: string | null
  title: string
  artist: string
  coverUrl: string | null
  duration: number
  position: number
  playing: boolean
  advancing: boolean
  rate: number
  capturedAt: number
  theme: string
}

type Action = 'dismiss' | 'show' | 'quit' | 'previous' | 'toggle' | 'next'

const send = (action: Action) => {
  void invoke('tray_player_action', { action: { action } }).catch(() => undefined)
}

export function TrayPlayer() {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Esc') send('dismiss')
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [])
  useEffect(() => {
    let active = true
    const receive = (frame: Snapshot) => {
      if (!active) return
      setSnapshot(previous => previous && previous.capturedAt > frame.capturedAt ? previous : frame)
      setNow(Date.now())
    }
    const subscription = listen<Snapshot>('tray-player-state', ({ payload }) => receive(payload))
    void subscription.catch(() => undefined).then(() => {
      if (active) return invoke<Snapshot>('tray_player_snapshot').then(receive).catch(() => undefined)
    })
    return () => { active = false; void subscription.then(stop => stop(), () => undefined) }
  }, [])
  useEffect(() => {
    if (snapshot?.theme === 'light' || snapshot?.theme === 'dark') {
      document.documentElement.dataset.theme = snapshot.theme
    }
  }, [snapshot?.theme])
  useEffect(() => {
    if (!snapshot?.advancing) return
    const tick = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now())
    }, 500)
    return () => window.clearInterval(tick)
  }, [snapshot?.advancing])

  const hasTrack = Boolean(snapshot?.id)
  const duration = hasTrack ? Math.max(0, snapshot?.duration ?? 0) : 0
  const elapsed = snapshot?.advancing ? Math.max(0, now - snapshot.capturedAt) / 1000 * snapshot.rate : 0
  const position = Math.min(duration, Math.max(0, (snapshot?.position ?? 0) + elapsed))
  const play = snapshot?.playing ? '暂停' : '播放'
  return <section className="tray-player" aria-label="状态栏播放器">
    <div className="tray-player-track">
      <Artwork className="tray-player-artwork" src={snapshot?.coverUrl ?? undefined} />
      <div className="tray-player-info">
        <strong title={snapshot?.title || undefined}>{snapshot?.title || '未在播放'}</strong>
        {hasTrack && <span title={snapshot?.artist}>{snapshot?.artist}</span>}
      </div>
    </div>
    <div className="tray-player-time">
      <span>{formatDuration(position)}</span>
      <progress aria-label="播放进度" value={position} max={Math.max(1, duration)} />
      <span>{formatDuration(duration)}</span>
    </div>
    <div className="tray-player-controls">
      <button type="button" aria-label="上一首" title="上一首" disabled={!hasTrack} onClick={() => send('previous')}><SkipBack size={17} fill="currentColor" /></button>
      <button type="button" className="tray-player-toggle" aria-label={play} title={play} disabled={!hasTrack} onClick={() => send('toggle')}>
        {snapshot?.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <button type="button" aria-label="下一首" title="下一首" disabled={!hasTrack} onClick={() => send('next')}><SkipForward size={17} fill="currentColor" /></button>
    </div>
    <div className="tray-player-actions">
      <button type="button" onClick={() => send('show')}><ArrowUpRight size={14} />打开 BiliMusic</button>
      <button type="button" onClick={() => send('quit')}><Power size={14} />退出应用</button>
    </div>
  </section>
}
