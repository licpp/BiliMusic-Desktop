type VideoClock = Pick<HTMLVideoElement,
  'readyState' | 'seeking' | 'currentTime' | 'playbackRate' | 'paused' | 'pause' | 'play' | 'buffered'
>

function hasBufferedTarget(buffered: TimeRanges, target: number) {
  for (let index = 0; index < buffered.length; index += 1) {
    if (buffered.start(index) <= target && target + .15 <= buffered.end(index)) return true
  }
  return false
}

type StartupAlignment = { waitForDecodedFrame: boolean }

// Returns whether an explicit alignment still needs to be applied.
export function synchronizeVideo(
  video: VideoClock, audioTime: number, playing: boolean, previousTime: number, force = false, elapsedSeconds = 0, rate = 1,
  startup?: StartupAlignment,
) {
  if (!playing && !video.paused) video.pause()
  const change = audioTime - previousTime
  const jumped = change < -1 || change > elapsedSeconds * rate + 1
  const align = force || jumped
  const ready = video.readyState >= 2
  if (video.readyState < 1 || video.seeking || (startup?.waitForDecodedFrame && !ready)) return align

  const target = Math.max(0, audioTime)
  const drift = target - video.currentTime
  // A short lead while audio starts does not need a second range request.
  const nearBeginning = startup && playing && !jumped && target <= 1 && video.currentTime < .2
  // A completed seek can already be seconds behind the still-playing audio.
  // Don't discard that frame and start another CDN request to chase the clock.
  const bufferedCorrection = ready && Math.abs(drift) > 2 && hasBufferedTarget(video.buffered, target)
  if (!nearBeginning && Math.abs(drift) > .2 && (align || (ready && !playing) || bufferedCorrection)) {
    video.currentTime = target
    video.playbackRate = rate
    return false
  }

  if (ready) {
    video.playbackRate = rate * (Math.abs(drift) < .12 ? 1 : drift > 2 ? 1.18 : drift > 0 ? 1.06 : .94)
    if (playing && video.paused) void video.play().catch(() => undefined)
  }
  return false
}
