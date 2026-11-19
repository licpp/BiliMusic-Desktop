import { useLayoutEffect, useRef, type RefObject } from 'react'
import { registerOverlay } from './overlayStack'
import type { SlideTiming } from './slideNavigation'

export function useOverlayDismiss(element: RefObject<HTMLElement | null>, open: boolean, dismiss: (timing?: SlideTiming) => void, raise = false) {
  const action = useRef(dismiss)
  action.current = dismiss
  useLayoutEffect(() => {
    if (open && element.current) return registerOverlay(element.current, timing => action.current(timing), raise)
  }, [element, open, raise])
}
