export type MarqueeMotion = { duration: number; frames: { offset: number; x: number }[] }

export function marqueeMotion(viewport: number, text: number, gap = 32): MarqueeMotion | null {
  if (!Number.isFinite(viewport) || !Number.isFinite(text) || viewport <= 0 || text <= viewport + 1) return null
  const speed = 28, startHold = 1600, endHold = 1100
  const overflow = text - viewport, distance = text + gap
  const endAt = startHold + overflow / speed * 1000
  const duration = startHold + endHold + distance / speed * 1000
  return { duration, frames: [
    { x: 0, offset: 0 },
    { x: 0, offset: startHold / duration },
    { x: -overflow, offset: endAt / duration },
    { x: -overflow, offset: (endAt + endHold) / duration },
    { x: -distance, offset: 1 },
  ] }
}

export function marqueeOffset(motion: MarqueeMotion, elapsed: number) {
  const position = Math.max(0, elapsed) % motion.duration / motion.duration
  for (let index = 1; index < motion.frames.length; index++) {
    const end = motion.frames[index], start = motion.frames[index - 1]
    if (position <= end.offset) return start.x + (end.x - start.x) * (position - start.offset) / (end.offset - start.offset)
  }
  return 0
}

// Own the frame clock independently of media samples and React renders. Re-arm
// on foreground entry rather than replaying a suspended WebKit Animation object.
export function animateMarquee(content: HTMLElement, motion: MarqueeMotion, hoverTarget?: HTMLElement) {
  let frame: number | undefined, previous: number | undefined, elapsed = 0, generation = 0, disposed = false, suspended = false
  let hovering = hoverTarget?.matches(':hover') ?? false
  const paint = () => { content.style.transform = `translate3d(${marqueeOffset(motion, elapsed)}px,0,0)` }
  const stop = () => { generation++; if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; previous = undefined }
  const tick = (now: number) => {
    frame = undefined
    if (disposed || suspended || document.hidden || hovering) return
    // Some WebViews omit visibility events while the OS freezes their process.
    // Do not charge an unobserved suspension to visible scrolling time.
    if (previous !== undefined && now - previous < 10_000) elapsed += Math.max(0, now - previous)
    previous = now
    paint()
    schedule()
  }
  const schedule = () => {
    const current = generation
    frame = requestAnimationFrame(now => { if (!disposed && current === generation) tick(now) })
  }
  const wake = () => {
    stop()
    if (disposed || suspended || document.hidden || hovering) return
    paint()
    schedule()
  }
  const visibility = () => { suspended = document.hidden; if (!suspended) hovering = hoverTarget?.matches(':hover') ?? false; wake() }
  const foreground = () => { suspended = false; hovering = hoverTarget?.matches(':hover') ?? false; wake() }
  const pageHide = () => { suspended = true; stop() }
  const enter = () => { hovering = true; stop() }
  const leave = () => { hovering = false; wake() }
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pageshow', foreground)
  window.addEventListener('focus', foreground)
  window.addEventListener('pagehide', pageHide)
  hoverTarget?.addEventListener('mouseenter', enter)
  hoverTarget?.addEventListener('mouseleave', leave)
  paint(); wake()
  return () => {
    disposed = true; stop(); content.style.removeProperty('transform')
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pageshow', foreground)
    window.removeEventListener('focus', foreground)
    window.removeEventListener('pagehide', pageHide)
    hoverTarget?.removeEventListener('mouseenter', enter)
    hoverTarget?.removeEventListener('mouseleave', leave)
  }
}
