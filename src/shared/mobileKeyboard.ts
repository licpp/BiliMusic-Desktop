import { isMobile } from '../services/platform'

export function installMobileKeyboard() {
  if (!isMobile) return
  const viewport = window.visualViewport
  const root = document.documentElement
  let adjustment: { container: HTMLElement; scrollTop: number } | undefined
  let scheduled = false

  const update = () => {
    scheduled = false
    const focused = document.activeElement
    const input = focused instanceof HTMLElement && focused.matches('input:not([type=range]):not([type=checkbox]),textarea,[contenteditable=true]') ? focused : null
    const native = Number.parseFloat(root.style.getPropertyValue('--native-keyboard')) || 0
    const overlap = Math.max(native, viewport ? window.innerHeight - viewport.height : 0)
    if (!input || overlap < 80) {
      root.style.removeProperty('--keyboard-overlap')
      delete root.dataset.keyboardOpen
      if (adjustment) adjustment.container.scrollTop = adjustment.scrollTop
      adjustment = undefined
      return
    }
    root.style.setProperty('--keyboard-overlap', `${overlap}px`)
    root.dataset.keyboardOpen = 'true'
    const container = input.closest<HTMLElement>('.mobile-page-content,.stage-scroll,.import-body')
    const hiddenBy = input.getBoundingClientRect().bottom - (window.innerHeight - overlap - 16)
    if (container && hiddenBy > 0) {
      if (!adjustment || adjustment.container !== container) adjustment = { container, scrollTop: container.scrollTop }
      container.scrollTop += hiddenBy
    }
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(update)
  }
  viewport?.addEventListener('resize', schedule)
  window.addEventListener('bilimusic-keyboard', schedule)
  document.addEventListener('focusin', schedule)
  document.addEventListener('focusout', schedule)
}
