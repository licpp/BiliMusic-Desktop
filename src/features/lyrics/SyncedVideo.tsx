import { memo, useEffect, useRef, useState } from 'react'
import { playbackClock, usePlayerStore } from '../player/playerStore'
import { synchronizeVideo } from './videoSync'
import { Artwork } from '../../shared/Artwork'
import { createVideoRecovery } from './videoRecovery'
import { commandErrorMessage } from '../../services/desktopApi'
import { LoaderCircle } from 'lucide-react'

export const SyncedVideo = memo(function SyncedVideo({ src, poster, active, onReady, onReload }: { src: string; poster?: string; active: boolean; onReady: (src: string) => void; onReload: () => Promise<void> }) {
  const ref = useRef<HTMLVideoElement>(null)
  const activeRef = useRef(active)
  const syncRef = useRef<(force?: boolean) => void>(() => {})
  const [error, setError] = useState('')
  const [visible, setVisible] = useState(false)
  const [slow, setSlow] = useState(false)
  const [retry, setRetry] = useState(0)
  const [recovering, setRecovering] = useState(false)
  const reloadRef = useRef(onReload)
  reloadRef.current = onReload
  const recovery = useRef<ReturnType<typeof createVideoRecovery> | null>(null)
  useEffect(() => {
    const controller = createVideoRecovery({
      refresh: () => reloadRef.current(),
      restart: () => setRetry(value => value + 1),
      busy: setRecovering,
      failed: cause => setError(`视频重新连接失败：${commandErrorMessage(cause)}`),
    })
    recovery.current = controller
    return () => { controller.dispose(); recovery.current = null }
  }, [])
  useEffect(() => {
    const video = ref.current
    if (!video) return
    setError(''); setVisible(false); setSlow(false)
    let firstFrameShown = false
    let pendingAlignment = true
    let startupRequested = false
    let disposed = false
    let previousTime = playbackClock()
    let previousCheck = performance.now()
    let stableSince = performance.now()
    let lastFrameTime = video.currentTime
    const sync = (force = false) => {
      if (document.hidden || !activeRef.current) { video.pause(); stableSince = performance.now(); return }
      if (video.error) { if (force) void recovery.current?.recover(); return }
      const time = playbackClock()
      const now = performance.now()
      const player = usePlayerStore.getState()
      // WKWebView may stop preloading at metadata. Request playback before
      // waiting for decoded data, once per playback intent rather than each tick.
      if (player.status === 'playing' && !startupRequested) {
        startupRequested = true
        void video.play().catch(cause => {
          if (!disposed && cause?.name === 'NotAllowedError') setError('请再次点击播放视频')
        })
      } else if (player.status === 'paused') startupRequested = false
      pendingAlignment = synchronizeVideo(
        video, time, player.status === 'playing',
        previousTime, force || pendingAlignment, (now - previousCheck) / 1000, player.rate,
      )
      previousTime = time
      previousCheck = now
      if (player.status !== 'playing' || video.seeking || video.currentTime <= lastFrameTime) stableSince = now
      else if (now - stableSince > 20_000) recovery.current?.healthy()
      lastFrameTime = video.currentTime
      // A decoded frame is enough to uncover the video. A hidden video on
      // WKWebView may not receive a compositor frame callback.
      if (!firstFrameShown && !pendingAlignment && !video.seeking && video.readyState >= 2) {
        firstFrameShown = true
        setVisible(true); setError('')
        onReady(src)
      }
    }
    syncRef.current = sync
    const visibility = () => sync(true)
    const ready = () => sync()
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked']
    const failed = () => {
      if (disposed || video.error?.code === 1) return
      setError(video.error?.code === 4 ? '视频线路或编码不可用，请重新加载' : '视频加载失败，请重试')
      if (!document.hidden && activeRef.current) void recovery.current?.recover()
    }
    document.addEventListener('visibilitychange', visibility)
    for (const event of events) video.addEventListener(event, ready)
    video.addEventListener('error', failed)
    video.src = src
    video.load()
    sync()
    const slowTimer = window.setTimeout(() => setSlow(true), 5000)
    const timer = window.setInterval(ready, 250)
    const unsubscribe = usePlayerStore.subscribe((state, previous) => { if (state.status !== previous.status || state.rate !== previous.rate) sync() })
    return () => {
      disposed = true
      syncRef.current = () => {}
      window.clearTimeout(slowTimer)
      window.clearInterval(timer)
      unsubscribe()
      document.removeEventListener('visibilitychange', visibility)
      for (const event of events) video.removeEventListener(event, ready)
      video.removeEventListener('error', failed)
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [src, retry, onReady])
  useEffect(() => {
    activeRef.current = active
    if (active) syncRef.current(true)
    else ref.current?.pause()
  }, [active])
  return <><video ref={ref} className={`${visible ? 'synced-video ready' : 'synced-video'}${active ? '' : ' inactive'}`} muted playsInline preload="auto" />{active && !visible && !error && <div className="video-startup"><Artwork src={poster} /><div className="video-startup-status" role="status"><LoaderCircle size={16} className="spin" /><span>{slow ? '视频缓冲较慢，声音会继续播放' : '正在加载并同步视频…'}</span>{slow && <button disabled={recovering} onClick={() => { void recovery.current?.recover(true) }}>重试加载</button>}</div></div>}{active && error && <div className="video-error" role="alert"><span>{recovering ? '正在重新连接视频…' : error}</span><button disabled={recovering} onClick={() => { void recovery.current?.recover(true) }}>重新加载</button></div>}</>
})
