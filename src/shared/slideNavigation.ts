export const transformX = (pixels: number) => `translate3d(${pixels}px,0,0)`
const transformY = (pixels: number) => `translate3d(0,${pixels}px,0)`

type LinkedSlide = { element: HTMLElement; from: number; to: number }
export type SlideTiming = { duration: number; easing?: string; axis?: 'x' | 'y' }

// Hold the final frame until its owner commits the new layout in the same task.
export function slideNavigation(element: HTMLElement, from: number | string, to: number, timing: number | SlideTiming, settle: () => void, linked?: LinkedSlide) {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (preference.matches || !element.animate || from === to) {
    settle()
    return
  }
  const { duration, easing = 'cubic-bezier(.2,.75,.25,1)', axis = 'x' } = typeof timing === 'number' ? { duration: timing } : timing
  const transform = axis === 'x' ? transformX : transformY
  const options: KeyframeAnimationOptions = { duration, easing, fill: 'forwards' }
  const move = (target: HTMLElement, start: number | string, end: number) => target.animate([
    { transform: typeof start === 'number' ? transform(start) : start },
    { transform: transform(end) },
  ], options)
  const animation = move(element, from, to)
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
