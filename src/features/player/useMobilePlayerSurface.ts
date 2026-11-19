import { useLayoutEffect, useRef } from 'react'
import { slideNavigation, type SlideTiming } from '../../shared/slideNavigation'
import { usePanelPresence } from '../../shared/usePanelPresence'
import { holdListUpdates } from '../../shared/navigationListMotion'

const playerTiming: SlideTiming = { duration: 320, easing: 'cubic-bezier(.28,.32,.32,1)', axis: 'y' }

export function useMobilePlayerSurface(enabled: boolean, open: boolean) {
  const present = usePanelPresence(enabled && open, playerTiming.duration + 40)
  const surface = useRef<HTMLDivElement>(null)
  const dismissOffset = useRef<number | undefined>(undefined)
  const animation = useRef<Animation | undefined>(undefined)

  function animateTo(element: HTMLDivElement, destination: number, from: number | string) {
    const releaseLists = holdListUpdates()
    animation.current?.cancel()
    element.style.setProperty('--player-offset', `${destination}px`)
    element.setAttribute('data-player-moving', '')
    animation.current = slideNavigation(element, from, destination, playerTiming, () => {
      element.removeAttribute('data-player-moving')
    })
    if (animation.current) void animation.current.finished.then(releaseLists, releaseLists)
    else releaseLists()
  }

  useLayoutEffect(() => {
    const element = surface.current
    if (!element) return
    const offset = dismissOffset.current
    dismissOffset.current = undefined
    animateTo(element, open ? 0 : element.clientHeight, offset ?? getComputedStyle(element).transform)
  }, [open, present])

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
