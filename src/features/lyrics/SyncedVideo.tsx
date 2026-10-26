import { memo, useEffect, useRef, useState } from 'react'
import { playbackClock, usePlayerStore } from '../player/playerStore'
import { synchronizeVideo } from './videoSync'

export const SyncedVideo = memo(function SyncedVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const video = ref.current
    if (!video) return
    video.src = src
    setError('')
    let previousTime = playbackClock()
    const sync = (force = false) => {
      const time = playbackClock()
      synchronizeVideo(video, time, usePlayerStore.getState().status === 'playing', previousTime, force)
      previousTime = time
    }
    const metadata = () => sync(true)
    const ready = () => sync()
    const failed = () => setError(video.error?.code === 4 ? '当前视频编码不受支持，请重新加载' : '视频加载失败，请重试')
    video.addEventListener('loadedmetadata', metadata)
    video.addEventListener('canplay', ready)
    video.addEventListener('seeked', ready)
    video.addEventListener('error', failed)
    const timer = window.setInterval(ready, 250)
    const unsubscribe = usePlayerStore.subscribe((state, previous) => { if (state.status !== previous.status) sync() })
    return () => {
      window.clearInterval(timer); unsubscribe()
      video.removeEventListener('loadedmetadata', metadata); video.removeEventListener('canplay', ready); video.removeEventListener('seeked', ready); video.removeEventListener('error', failed)
      video.pause(); video.removeAttribute('src'); video.load()
    }
  }, [src])
  return <><video ref={ref} src={src} muted playsInline preload="auto" />{error && <div className="video-error" role="alert"><span>{error}</span><button onClick={() => { setError(''); ref.current?.load() }}>重新加载</button></div>}</>
})
