import { useLayoutEffect, type RefObject } from 'react'

export function usePanelReveal(panel: RefObject<HTMLElement | null>, open: boolean | undefined) {
  useLayoutEffect(() => {
    const element = panel.current
    if (!element || open === undefined) return
    if (open && !element.hasAttribute('data-panel-open')) {
      element.style.removeProperty('--lyrics-exit-y')
      // Commit the initial style before starting the transition. This also
      // lets an in-flight exit reverse from its current position.
      void element.offsetWidth
      element.setAttribute('data-panel-open', '')
    } else if (!open) element.removeAttribute('data-panel-open')
  }, [open, panel])
}
