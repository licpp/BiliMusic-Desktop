import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { ChevronLeft } from 'lucide-react'

import { lockAppForPortal } from './overlayStack'
import { useOverlayDismiss } from './useOverlayDismiss'
import { animatePage, stopPageMotion } from './pageMotion'
import { slideNavigation, type SlideTiming } from './slideNavigation'
import { edgeBackTiming } from './gestureRelease'
import { holdListUpdates } from './navigationListMotion'

const pages: HTMLElement[] = []
function updatePageStack() {
  if (pages.length) document.documentElement.dataset.mobilePageOpen = 'true'
  else delete document.documentElement.dataset.mobilePageOpen
  for (const page of pages) page.inert = page !== pages.at(-1) || page.hasAttribute('data-page-closing')
}

// A navigation page, with its own scroll view and fixed layout.
// Keeping the previous page mounted preserves drafts and the search position.
export function MobilePage({ title, onBack, actions, children, scrollContent = true, className = '' }: {
  title: string; onBack: () => void; actions?: ReactNode; children?: ReactNode; scrollContent?: boolean; className?: string
}) {
  const layer = useRef<HTMLElement>(null)
  const back = useRef(onBack)
  back.current = onBack
  const close = (timing?: SlideTiming) => {
    const page = layer.current
    if (!page || page.hasAttribute('data-page-closing')) return
    if (document.activeElement instanceof HTMLElement && page.contains(document.activeElement)) document.activeElement.blur()
    // Keep the underlay mounted and slide this opaque page entirely out of view.
    const position = getComputedStyle(page).transform
    stopPageMotion(page)
    page.setAttribute('data-page-closing', '')
    updatePageStack()
    const releaseLists = holdListUpdates()
    const animation = slideNavigation(page, position, page.clientWidth, timing ?? edgeBackTiming(page.clientWidth, page.clientWidth), () => flushSync(() => back.current()))
    if (animation) void animation.finished.then(releaseLists, releaseLists)
    else releaseLists()
  }
  useOverlayDismiss(layer, true, close, true)
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const page = layer.current!
    const unlock = lockAppForPortal()
    pages.push(page); updatePageStack()
    animatePage(page, 'forward', true)
    const backButton = page.querySelector<HTMLElement>('header button')
    backButton?.focus({ preventScroll: true })
    return () => {
      stopPageMotion(page)
      unlock()
      const index = pages.indexOf(page)
      if (index >= 0) pages.splice(index, 1)
      updatePageStack()
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
    }
  }, [])
  const header = <header className="mobile-page-header"><button type="button" aria-label="返回" onClick={() => close()}><ChevronLeft size={24}/></button><h2>{title}</h2><div>{actions}</div></header>
  return createPortal(<section ref={layer} className={`mobile-page ${className}`} data-mobile-page data-edge-back role="dialog" aria-modal="true" aria-label={title}>
    {header}
    <div className={scrollContent ? "mobile-page-content" : "mobile-page-content mobile-page-content-expanded"}>{children}</div>
  </section>, document.body)
}
