import { memo, useEffect, useRef, useState } from 'react'
import { playbackClock, usePlayerStore } from '../player/playerStore'
import { synchronizeVideo } from './videoSync'
import { Artwork } from '../../shared/Artwork'
import { LoaderCircle } from 'lucide-react'

export const SyncedVideo = memo(function SyncedVideo({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [visible, setVisible] = useState(false)
  const [slow, setSlow] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    setError(''); setVisible(false); setSlow(false)
    let disposed = false
    let frameCallback: number | undefined
    const supportsFrames = typeof video.requestVideoFrameCallback === 'function'
    const markVisible = () => { if (!disposed && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - playbackClock()) < 1.5) setVisible(true) }
    const observeFrame = () => {
      if (!supportsFrames || disposed) return
      frameCallback = video.requestVideoFrameCallback((_now, frame) => {
        frameCallback = undefined
        if (Math.abs(frame.mediaTime - playbackClock()) < 1.5 && !video.seeking) markVisible()
        else observeFrame()
      })
    }
    let previousTime = playbackClock()
    const sync = (force = false) => {
      const time = playbackClock()
      synchronizeVideo(video, time, usePlayerStore.getState().status === 'playing', previousTime, force)
      previousTime = time
    }
    const metadata = () => sync(true)
    const ready = () => { sync(); if (!supportsFrames) markVisible() }
    const failed = () => setError(video.error?.code === 4 ? '当前视频编码不受支持，请重新加载' : '视频加载失败，请重试')
    video.addEventListener('loadedmetadata', metadata)
    video.addEventListener('canplay', ready)
    video.addEventListener('loadeddata', ready)
    video.addEventListener('seeked', ready)
    video.addEventListener('error', failed)
    const start = Math.max(0, playbackClock())
    // Media fragments let the browser request the current position during startup.
    video.src = start > .2 ? `${src}#t=${start.toFixed(3)}` : src
    observeFrame()
    const slowTimer = window.setTimeout(() => setSlow(true), 5000)
    const timer = window.setInterval(ready, 250)
    const unsubscribe = usePlayerStore.subscribe((state, previous) => { if (state.status !== previous.status) sync() })
    return () => {
      window.clearInterval(timer); unsubscribe()
      disposed = true; window.clearTimeout(slowTimer)
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback)
      video.removeEventListener('loadedmetadata', metadata); video.removeEventListener('canplay', ready); video.removeEventListener('loadeddata', ready); video.removeEventListener('seeked', ready); video.removeEventListener('error', failed)
      video.pause(); video.removeAttribute('src'); video.load()
    }
  }, [src, retry])
  return <><video ref={ref} className={visible ? 'synced-video ready' : 'synced-video'} muted playsInline preload="auto" />{!visible && <div className="video-startup"><Artwork src={poster} /><div className="video-startup-status" role="status"><LoaderCircle size={16} className="spin" /><span>{slow ? '视频缓冲较慢，声音会继续播放' : '正在加载并同步视频…'}</span>{slow && <button onClick={() => setRetry((value) => value + 1)}>重试加载</button>}</div></div>}{error && <div className="video-error" role="alert"><span>{error}</span><button onClick={() => setRetry((value) => value + 1)}>重新加载</button></div>}</>
})
