import { useLayoutEffect, useRef, type RefObject } from 'react'

type PageMotion = 'forward' | 'back' | 'switch' | 'player'

const running = new WeakMap<HTMLElement, Animation>()

export function stopPageMotion(element: HTMLElement) {
  running.get(element)?.cancel()
}

export function animatePage(element: HTMLElement, motion: PageMotion, touch: boolean) {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (preference.matches || !element.animate) return
  stopPageMotion(element)
  const distance = touch ? 34 : 16
  const direction = motion === 'back' ? -1 : 1
  const startingPosition = motion === 'switch' || motion === 'player'
    ? `translate3d(0, ${motion === 'player' ? 22 : 6}px, 0)`
    : `translate3d(${direction * distance}px, 0, 0)`
  const frames = [{ opacity: motion === 'back' ? 1 : motion === 'switch' ? .5 : .62, transform: startingPosition }, { opacity: 1, transform: 'none' }]
  const duration = motion === 'switch' ? 175 : touch ? 245 : 215
  const animation = element.animate(frames, { duration, easing: 'cubic-bezier(.2,.75,.25,1)' })
  running.set(element, animation)
  const update = () => { if (preference.matches) animation.finish() }
  if (preference.addEventListener) preference.addEventListener('change', update)
  else preference.addListener(update)
  const clean = () => {
    if (preference.removeEventListener) preference.removeEventListener('change', update)
    else preference.removeListener(update)
    if (running.get(element) === animation) running.delete(element)
  }
  if (animation.finished) void animation.finished.then(clean, clean)
  else {
    animation.onfinish = clean
    animation.oncancel = clean
  }
  return animation
}

export function usePageMotion(target: RefObject<HTMLElement | null>, route: string, depth: number, touch: boolean, intent?: RefObject<PageMotion | undefined>, enabled = true) {
  const previous = useRef({ route, depth })
  useLayoutEffect(() => {
    const old = previous.current
    previous.current = { route, depth }
    const requested = intent?.current
    if (intent) intent.current = undefined
    if (!enabled || old.route === route || !target.current || target.current.closest('[data-swipe-settling]')) return
    const kind = requested ?? (depth < old.depth ? 'back' : depth > old.depth ? 'forward' : 'switch')
    const animation = animatePage(target.current, kind, touch)
    return () => animation?.cancel()
  }, [target, route, depth, touch, intent, enabled])
}
