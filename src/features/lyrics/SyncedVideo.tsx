import { memo, useEffect, useRef, useState } from 'react'
import { playbackClock, usePlayerStore } from '../player/playerStore'
import { synchronizeVideo } from './videoSync'
import { Artwork } from '../../shared/Artwork'
import { LoaderCircle } from 'lucide-react'

export const SyncedVideo = memo(function SyncedVideo({ src, poster, active, onReady }: { src: string; poster?: string; active: boolean; onReady: (src: string) => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  const activeRef = useRef(active)
  const syncRef = useRef<(force?: boolean) => void>(() => {})
  const [error, setError] = useState('')
  const [visible, setVisible] = useState(false)
  const [slow, setSlow] = useState(false)
  const [retry, setRetry] = useState(0)
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
    const sync = (force = false) => {
      if (document.hidden || !activeRef.current) { video.pause(); return }
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
      // A decoded frame is enough to uncover the video. A hidden video on
      // WKWebView may not receive a compositor frame callback.
      if (!firstFrameShown && !pendingAlignment && !video.seeking && video.readyState >= 2) {
        firstFrameShown = true
        setVisible(true)
        onReady(src)
      }
    }
    syncRef.current = sync
    const visibility = () => sync(true)
    const ready = () => sync()
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked']
    const failed = () => setError(video.error?.code === 4 ? '当前视频编码不受支持，请重新加载' : '视频加载失败，请重试')
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
  return <><video ref={ref} className={`${visible ? 'synced-video ready' : 'synced-video'}${active ? '' : ' inactive'}`} muted playsInline preload="auto" />{active && !visible && <div className="video-startup"><Artwork src={poster} /><div className="video-startup-status" role="status"><LoaderCircle size={16} className="spin" /><span>{slow ? '视频缓冲较慢，声音会继续播放' : '正在加载并同步视频…'}</span>{slow && <button onClick={() => setRetry((value) => value + 1)}>重试加载</button>}</div></div>}{active && error && <div className="video-error" role="alert"><span>{error}</span><button onClick={() => setRetry((value) => value + 1)}>重新加载</button></div>}</>
})
