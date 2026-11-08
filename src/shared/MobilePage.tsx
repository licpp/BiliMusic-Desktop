import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft } from 'lucide-react'

const pages: HTMLElement[] = []
let originalRootInert = false
function updatePageStack() {
  const root = document.getElementById('root')
  if (root) root.inert = pages.length > 0 || originalRootInert
  if (pages.length) document.documentElement.dataset.mobilePageOpen = 'true'
  else delete document.documentElement.dataset.mobilePageOpen
  for (const page of pages) page.inert = page !== pages.at(-1)
}

// A navigation page, with its own scroll view and keyboard-sized viewport.
// Keeping the previous page mounted preserves drafts and the search position.
export function MobilePage({ title, onBack, actions, children, className = '' }: {
  title: string; onBack: () => void; actions?: ReactNode; children: ReactNode; className?: string
}) {
  const layer = useRef<HTMLElement>(null)
  const back = useRef(onBack)
  back.current = onBack
  useEffect(() => {
    const root = document.getElementById('root')
    const previous = document.activeElement as HTMLElement | null
    const page = layer.current!
    if (!pages.length) originalRootInert = root?.inert || false
    pages.push(page); updatePageStack()
    const top = () => [...document.querySelectorAll('[data-mobile-page]')].at(-1) === layer.current
    const dismiss = (event: Event) => {
      if (!top() || event.defaultPrevented || document.querySelector('[data-overflow-panel],.track-context-menu,.dialog-backdrop,.lyric-chooser-backdrop')) return
      event.preventDefault(); event.stopImmediatePropagation(); back.current()
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(event) }
    const resize = () => {
      layer.current?.style.setProperty('--page-height', `${window.visualViewport?.height || window.innerHeight}px`)
      layer.current?.style.setProperty('--page-top', `${window.visualViewport?.offsetTop || 0}px`)
    }
    resize()
    window.visualViewport?.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('scroll', resize)
    window.addEventListener('resize', resize)
    window.addEventListener('bilimusic-back', dismiss, true)
    document.addEventListener('keydown', key, true)
    layer.current?.querySelector<HTMLElement>('header button')?.focus({ preventScroll: true })
    return () => {
      window.visualViewport?.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('scroll', resize)
      window.removeEventListener('resize', resize)
      window.removeEventListener('bilimusic-back', dismiss, true)
      document.removeEventListener('keydown', key, true)
      const index = pages.indexOf(page)
      if (index >= 0) pages.splice(index, 1)
      updatePageStack()
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
    }
  }, [])
  return createPortal(<section ref={layer} className={`mobile-page ${className}`} data-mobile-page role="dialog" aria-modal="true" aria-label={title}>
    <header className="mobile-page-header"><button type="button" aria-label="返回" onClick={onBack}><ChevronLeft size={24}/></button><h2>{title}</h2><div>{actions}</div></header>
    <div className="mobile-page-content">{children}</div>
  </section>, document.body)
}
