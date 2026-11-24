import { useLayoutEffect, useRef } from 'react'
import { slideNavigation, type SlideTiming } from '../../shared/slideNavigation'
import { usePanelPresence } from '../../shared/usePanelPresence'
import { holdListUpdates } from '../../shared/navigationListMotion'

const playerTiming: SlideTiming = { duration: 320, easing: 'cubic-bezier(.28,.32,.32,1)', axis: 'y' }
const tabletTiming: SlideTiming = { duration: 200, easing: 'ease-out', axis: 'y' }

export function useMobilePlayerSurface(enabled: boolean, open: boolean, tablet: boolean) {
  const timing = tablet ? tabletTiming : playerTiming
  const present = usePanelPresence(enabled && open, timing.duration + (tablet ? 24 : 40))
  const surface = useRef<HTMLDivElement>(null)
  const dismissOffset = useRef<number | undefined>(undefined)
  const animation = useRef<Animation | undefined>(undefined)

  function animateTo(element: HTMLDivElement, destination: number, from: number | string, opacity?: SlideTiming['opacity']) {
    const releaseLists = holdListUpdates()
    animation.current?.cancel()
    element.style.setProperty('--player-offset', `${destination}px`)
    if (opacity) element.style.setProperty('--player-opacity', String(opacity.to))
    else element.style.removeProperty('--player-opacity')
    element.setAttribute('data-player-moving', '')
    animation.current = slideNavigation(element, from, destination, { ...timing, opacity }, () => {
      element.removeAttribute('data-player-moving')
    })
    if (animation.current) void animation.current.finished.then(releaseLists, releaseLists)
    else releaseLists()
  }

  useLayoutEffect(() => {
    const element = surface.current
    if (!element) {
      animation.current?.cancel()
      return
    }
    const offset = dismissOffset.current
    dismissOffset.current = undefined
    const style = getComputedStyle(element)
    if (tablet) {
      const firstFrame = !element.style.getPropertyValue('--player-offset')
      const destination = open ? 0 : offset ?? 0
      animateTo(element, destination, offset ?? (firstFrame ? 0 : style.transform), {
        from: firstFrame ? 0 : Number(style.opacity),
        to: open ? 1 : 0,
      })
    } else {
      animateTo(element, open ? 0 : element.clientHeight, offset ?? style.transform)
    }
  }, [enabled, open, present, tablet])

  useLayoutEffect(() => () => {
    animation.current?.cancel()
  }, [])

  return {
    ref: surface,
    present: enabled && present,
    releaseDismiss(offset: number, dismissed: boolean) {
      if (!offset) return
      if (dismissed) dismissOffset.current = offset
      else if (surface.current) animateTo(surface.current, 0, offset)
    },
  }
}
