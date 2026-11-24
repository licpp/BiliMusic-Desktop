export const transformX = (pixels: number) => `translate3d(${pixels}px,0,0)`
const transformY = (pixels: number) => `translate3d(0,${pixels}px,0)`

type LinkedSlide = { element: HTMLElement; from: number; to: number }
export type SlideTiming = { duration: number; easing?: string; axis?: 'x' | 'y'; opacity?: { from: number; to: number } }

// Hold the final frame until its owner commits the new layout in the same task.
export function slideNavigation(element: HTMLElement, from: number | string, to: number, timing: number | SlideTiming, settle: () => void, linked?: LinkedSlide) {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  const { duration, easing = 'cubic-bezier(.2,.75,.25,1)', axis = 'x', opacity } = typeof timing === 'number' ? { duration: timing } : timing
  if (preference.matches || !element.animate || (from === to && opacity?.from === opacity?.to)) {
    settle()
    return
  }
  const transform = axis === 'x' ? transformX : transformY
  const options: KeyframeAnimationOptions = { duration, easing, fill: 'forwards' }
  const move = (target: HTMLElement, start: number | string, end: number, fade?: SlideTiming['opacity']) => target.animate([
    { transform: typeof start === 'number' ? transform(start) : start, ...(fade && { opacity: fade.from }) },
    { transform: transform(end), ...(fade && { opacity: fade.to }) },
  ], options)
  const animation = move(element, from, to, opacity)
  const companion = linked && move(linked.element, linked.from, linked.to)
  const update = () => {
    if (!preference.matches) return
    animation.finish()
    companion?.finish()
  }
  preference.addEventListener('change', update)
  const clean = () => {
    preference.removeEventListener('change', update)
    companion?.cancel()
  }
  // Both animations share the document timeline, duration and easing.
  const finished = companion ? Promise.all([animation.finished, companion.finished]) : animation.finished
  void finished.then(() => {
    try { if (element.isConnected) settle() }
    finally { clean(); animation.cancel() }
  }, clean)
  return animation
}
