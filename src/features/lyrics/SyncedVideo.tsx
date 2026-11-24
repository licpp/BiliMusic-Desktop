import { reportVideoIssue, videoDiagnosticTrace, videoSourceIssue, type VideoDiagnosticTrace } from './videoDiagnostics'
import { memo, useEffect, useRef, useState } from 'react'
import { playbackClock, usePlayerStore } from '../player/playerStore'
import { createBufferedFrameWatch, synchronizeVideo } from './videoSync'
import { VideoStartup } from './VideoStartup'
import { createVideoRecovery } from './videoRecovery'
import { isAndroid, isLargeScreen, needsDecodedFrameBeforeVideoSeek } from '../../services/platform'
import type { Track } from '../../domain/track'
import { CopyPlaybackDiagnostics, PlaybackErrorText } from '../player/PlaybackError'
import { playbackIssue, type PlaybackIssue } from '../player/playbackIssue'

const waitForCompositor = isAndroid && isLargeScreen
const startupAlignment = { waitForDecodedFrame: needsDecodedFrameBeforeVideoSeek }

export const SyncedVideo = memo(function SyncedVideo({ src, poster, track, codecs, diagnostic, active, suspended = false, onReady, onReload }: { src: string; poster?: string; track: Track; codecs?: string; diagnostic?: VideoDiagnosticTrace; active: boolean; suspended?: boolean; onReady: (src: string) => void; onReload: (compatible: boolean) => Promise<boolean | void> }) {
  const ref = useRef<HTMLVideoElement>(null)
  const activeRef = useRef(active && !suspended)
  const syncRef = useRef<(force?: boolean) => void>(() => {})
  const [error, setError] = useState<PlaybackIssue | null>(null)
  const [frame, setFrame] = useState<{ src: string; attempt: number }>()
  const [slowIssue, setSlowIssue] = useState<PlaybackIssue | null>(null)
  const [retry, setRetry] = useState(0)
  const [legacyAvcSource, setLegacyAvcSource] = useState<string>()
  const legacyAvc = needsDecodedFrameBeforeVideoSeek && codecs?.startsWith('avc1.') && !src.includes('?')
  const useLegacyAvc = legacyAvc && legacyAvcSource === src
  const videoUrl = useLegacyAvc ? `${src}?legacy_avc=1` : src
  const visible = frame?.src === videoUrl && frame.attempt === retry
  const [recovering, setRecovering] = useState(false)
  const reloadRef = useRef(onReload)
  reloadRef.current = onReload
  const recovery = useRef<ReturnType<typeof createVideoRecovery> | null>(null)
  useEffect(() => {
    const controller = createVideoRecovery({
      refresh: () => {
        const code = ref.current?.error?.code
        return reloadRef.current(code === 3 || code === 4)
      },
      restart: () => setRetry(value => value + 1),
      busy: setRecovering,
      failed: cause => setError(videoSourceIssue(cause)),
    })
    recovery.current = controller
    return () => { controller.dispose(); recovery.current = null }
  }, [])
  useEffect(() => {
    const video = ref.current
    if (!video) return
    const trace = diagnostic ?? videoDiagnosticTrace(track.source.bvid, track.source.cid)
    trace.update({ codec: codecs })
    trace.emit('start', 'started')
    setError(null); setSlowIssue(null)
    let firstFrameShown = false
    let pendingAlignment = true
    let startupRequested = false
    let disposed = false
    let previousTime = playbackClock()
    let previousCheck = performance.now()
    let stableSince = performance.now()
    let lastFrameTime = video.currentTime
    let frameCallback: number | undefined
    let startupFrames = 0
    let frameWait: { since: number; position: number } | undefined
    let stoppedForStall = false
    const bufferedFrames = legacyAvc ? createBufferedFrameWatch() : undefined
    const canRevealFrame = () => {
      const status = usePlayerStore.getState().status
      return !disposed && !document.hidden && activeRef.current && !pendingAlignment &&
        !video.seeking && !video.error && video.readyState >= 2 &&
        (!waitForCompositor || (status !== 'resolving' && status !== 'buffering'))
    }
    const showFrame = () => {
      if (firstFrameShown || !canRevealFrame()) return
      firstFrameShown = true
      trace.emit('start', 'succeeded')
      if (retry > 0 || useLegacyAvc) trace.emit('recovery', 'succeeded')
      setFrame({ src: videoUrl, attempt: retry }); setError(null)
      onReady(src)
    }
    const waitForFrame = () => {
      if (frameCallback !== undefined) return
      frameCallback = video.requestVideoFrameCallback(() => {
        frameCallback = undefined
        if (!canRevealFrame()) { startupFrames = 0; return }
        if (++startupFrames >= 2) showFrame()
        else waitForFrame()
      })
    }
    const sync = (force = false) => {
      if (document.hidden || !activeRef.current || stoppedForStall) {
        video.pause(); stableSince = performance.now(); bufferedFrames?.reset(); return
      }
      if (video.error) { if (force) void recovery.current?.recover(); return }
      const time = playbackClock()
      const now = performance.now()
      const player = usePlayerStore.getState()
      // WKWebView may stop preloading at metadata. Request playback before
      // waiting for decoded data, once per playback intent rather than each tick.
      if (player.status === 'playing' && !startupRequested) {
        startupRequested = true
        void video.play().catch(cause => {
          if (!disposed && cause?.name === 'NotAllowedError') {
            setError(playbackIssue('video-start', null, '请再次点击播放视频', 'autoplay_blocked'))
          }
        })
      } else if (player.status === 'paused') startupRequested = false
      pendingAlignment = synchronizeVideo(
        video, time, player.status === 'playing',
        previousTime, force || pendingAlignment, (now - previousCheck) / 1000, player.rate,
        firstFrameShown ? undefined : startupAlignment,
      )
      previousTime = time
      previousCheck = now
      if (player.status !== 'playing') bufferedFrames?.reset()
      else if (bufferedFrames?.stalled(video.buffered, video.currentTime,
        (video as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount, time, now)) {
        stoppedForStall = true
        video.pause()
        setFrame(undefined)
        const issue = reportVideoIssue(trace, playbackIssue('video-decode', null,
          '当前视频画面无法解码，声音会继续播放', 'video_stalled'))
        if (useLegacyAvc) {
          trace.emit('recovery', 'failed', { code: issue.code })
          setError(issue)
        } else {
          trace.emit('recovery', 'started')
          setLegacyAvcSource(src)
        }
        return
      }
      if (player.status !== 'playing' || video.seeking || video.currentTime <= lastFrameTime) stableSince = now
      else if (now - stableSince > 20_000) recovery.current?.healthy()
      lastFrameTime = video.currentTime
      if (!firstFrameShown && canRevealFrame()) {
        if (waitForCompositor && !video.paused && typeof video.requestVideoFrameCallback === 'function') {
          frameWait ??= { since: now, position: video.currentTime }
          // Some WebViews defer compositor callbacks while the poster covers the video.
          if (now - frameWait.since > 1000 && video.currentTime > frameWait.position + .25) showFrame()
          else waitForFrame()
        } else showFrame()
      } else frameWait = undefined
    }
    syncRef.current = sync
    const visibility = () => sync(true)
    const ready = () => sync()
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked']
    const failed = () => {
      if (disposed || video.error?.code === 1) return
      const code = video.error?.code
      setError(reportVideoIssue(trace, playbackIssue(code === 3 || code === 4 ? 'video-decode' : 'video-buffer', null,
        code === 3 ? '视频解码失败，请重新加载' : code === 4 ? '视频线路或编码不可用，请重新加载' : '视频加载失败，请重试',
        `html_media:${code}`)))
      if (!document.hidden && activeRef.current) void recovery.current?.recover()
    }
    document.addEventListener('visibilitychange', visibility)
    for (const event of events) video.addEventListener(event, ready)
    video.addEventListener('error', failed)
    video.src = videoUrl
    video.load()
    sync()
    const slowTimer = window.setTimeout(() => {
      if (!firstFrameShown && !stoppedForStall) setSlowIssue(reportVideoIssue(trace, playbackIssue('video-buffer', null, '视频缓冲较慢', 'video_stalled')))
    }, 5000)
    const timer = window.setInterval(ready, 250)
    const unsubscribe = usePlayerStore.subscribe((state, previous) => { if (state.status !== previous.status || state.rate !== previous.rate) sync() })
    return () => {
      disposed = true
      syncRef.current = () => {}
      window.clearTimeout(slowTimer)
      window.clearInterval(timer)
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback)
      unsubscribe()
      document.removeEventListener('visibilitychange', visibility)
      for (const event of events) video.removeEventListener(event, ready)
      video.removeEventListener('error', failed)
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [src, videoUrl, retry, onReady, diagnostic, codecs, legacyAvc, useLegacyAvc, track.source.bvid, track.source.cid])
  useEffect(() => {
    activeRef.current = active && !suspended
    if (activeRef.current) syncRef.current(true)
    else ref.current?.pause()
  }, [active, suspended])
  return <>
    <video ref={ref} className={`${visible ? 'synced-video ready' : 'synced-video'}${waitForCompositor ? ' wait-for-video-frame' : ''}${active ? '' : ' inactive'}`} muted playsInline preload="auto" />
    {active && <VideoStartup key={`${videoUrl}:${retry}`} poster={poster} ready={visible}
      message={error || suspended ? undefined : slowIssue ? '视频缓冲较慢，声音会继续播放' : '正在加载并同步视频…'}>
      {slowIssue && <><button disabled={recovering} onClick={() => { void recovery.current?.recover(true) }}>重试加载</button>
        <CopyPlaybackDiagnostics issue={slowIssue} track={track} codecs={codecs}/></>}
    </VideoStartup>}
    {active && error && <div className="video-error" role="alert">
      {recovering ? <span>正在重新连接视频…</span> : <PlaybackErrorText issue={error}/>}
      <div className="playback-issue-actions"><button disabled={recovering} onClick={() => { void recovery.current?.recover(true) }}>重新加载</button>
        <CopyPlaybackDiagnostics issue={error} track={track} codecs={codecs}/></div>
    </div>}
  </>
})
