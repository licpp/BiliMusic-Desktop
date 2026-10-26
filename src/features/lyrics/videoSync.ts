type VideoClock = Pick<HTMLVideoElement, 'readyState' | 'seeking' | 'currentTime' | 'playbackRate' | 'paused' | 'pause' | 'play'>

export function synchronizeVideo(video: VideoClock, audioTime: number, playing: boolean, previousTime: number, force = false) {
  if (!playing && !video.paused) video.pause()
  if (video.readyState < 1 || video.seeking) return
  const drift = audioTime - video.currentTime
  const jumped = Math.abs(audioTime - previousTime) > 1
  if (force || jumped || (video.readyState >= 2 && Math.abs(drift) > 2)) {
    video.currentTime = Math.max(0, audioTime)
    video.playbackRate = 1
    return
  }
  // A buffering video must finish its existing seek instead of continually seeking forward.
  if (video.readyState < 2) return
  video.playbackRate = Math.abs(drift) < .12 ? 1 : drift > 0 ? 1.06 : .94
  if (playing && video.paused) void video.play().catch(() => undefined)
}
