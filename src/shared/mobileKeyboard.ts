import { isIOS, isMobile } from '../services/platform'
import { visibleViewport } from './visibleViewport'

export function installMobileKeyboard() {
  if (!isMobile) return
  const viewport = window.visualViewport
  const root = document.documentElement
  let baselineHeight = window.innerHeight
  let scheduled = false
  const update = () => {
    scheduled = false
    const focused = document.activeElement
    const input = focused instanceof HTMLElement && focused.matches('input:not([type=range]):not([type=checkbox]),textarea,[contenteditable=true]') ? focused : null
    const native = Number.parseFloat(root.style.getPropertyValue('--native-keyboard')) || 0
    const nativeLayout = Number.parseFloat(root.style.getPropertyValue('--native-layout-height')) || 0
    if (!input && native < 80) baselineHeight = window.innerHeight
    else baselineHeight = Math.max(baselineHeight, window.innerHeight)
    if (nativeLayout > 0) baselineHeight = Math.max(window.innerHeight,nativeLayout)
    const visible = visibleViewport(window.innerHeight, viewport?.height ?? window.innerHeight, viewport?.offsetTop ?? 0, baselineHeight, native, Boolean(input))
    root.style.setProperty('--visible-top', `${visible.top}px`)
    root.style.setProperty('--visible-height', `${visible.height}px`)
    root.style.setProperty('--keyboard-overlap', `${visible.overlap}px`)
    if (visible.keyboardOpen) root.dataset.keyboardOpen = 'true'
    else delete root.dataset.keyboardOpen
    // The application root never scrolls. WebKit can nevertheless pan it to
    // reveal the old input location before our keyboard layout has settled.
    // Keep modal scrolling local, and let the next viewport event recompute top.
    if (isIOS && window.scrollY !== 0 && document.querySelector('.comments-sheet-overlay,.mobile-page,.dialog-backdrop,.lyric-chooser-backdrop')) {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
      schedule()
    }
    if (!input || !visible.keyboardOpen) return
    const container = input.closest<HTMLElement>('.mobile-page-content,.stage-scroll,.import-body,.comments-scroll,.comment-compose,.collection-dialog,.lyric-chooser')
    const hiddenBy = input.getBoundingClientRect().bottom - (visible.top + visible.height - 16)
    // The active form owns scrolling. Never scroll body or restore an old
    // position over a user's scroll after closing the keyboard.
    if (container && hiddenBy > 0 && container.scrollHeight > container.clientHeight) container.scrollTop += hiddenBy
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(update)
  }
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  window.addEventListener('orientationchange', () => { baselineHeight=window.innerHeight; schedule() })
  window.addEventListener('bilimusic-keyboard', schedule)
  document.addEventListener('focusin', schedule)
  document.addEventListener('focusout', schedule)
  // Keyboard dismissal is a navigation step, before dismissing a dialog/page.
  window.addEventListener('bilimusic-back', event => {
    if (!root.dataset.keyboardOpen) return
    const focused = document.activeElement
    if (focused instanceof HTMLElement) focused.blur()
    event.preventDefault(); event.stopImmediatePropagation()
  }, true)
  update()
}
