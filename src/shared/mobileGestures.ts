import { touchDirection, type TouchDirection } from './touchDirection'
import { isMobile } from '../services/platform'

// Delegate long presses so every existing row context menu has the same touch
// semantics. Scrolling cancels the press; the release never becomes a play tap.
export function installMobileGestures() {
  if (!isMobile) return
  let press: { x: number; y: number; target: HTMLElement; edge: boolean; direction: TouchDirection } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let suppressUntil = 0
  const cancel = () => { clearTimeout(timer); timer = undefined }
  document.addEventListener('touchstart', event => {
    cancel()
    suppressUntil = 0
    if (event.touches.length !== 1) { press = undefined; return }
    const target = event.target as HTMLElement
    if (target.closest('[data-touch-picker]')) { press = undefined; return }
    const touch = event.touches[0]
    press = { x: touch.clientX, y: touch.clientY, target, edge: touch.clientX < 24, direction: 'pending' }
    if (target.closest('input,textarea,select,[contenteditable="true"],[data-overflow-panel],.track-context-menu')) return
    const row = target.closest<HTMLElement>('.result-main,.library-entry,.library-track,.video-part-row,.result-card,.queue-entry,.track-row')
    if (!row || target.closest('.icon-action,.action-menu-trigger')) return
    timer = setTimeout(() => {
      suppressUntil = performance.now() + 900
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: touch.clientX, clientY: touch.clientY }))
      press = undefined
    }, 480)
  }, { passive: true })
  document.addEventListener('touchmove', event => {
    if (event.touches.length > 1) { event.preventDefault(); press = undefined; cancel(); return }
    if (!press) return
    const touch = event.touches[0]
    if (touch) {
      press.direction = touchDirection(touch.clientX, touch.clientY, press.x, press.y, press.direction)
      if (press.direction === 'edge') event.preventDefault()
    }
    if (!touch || Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 9) cancel()
  }, { passive: false })
  document.addEventListener('touchend', event => {
    cancel()
    const touch = event.changedTouches[0]
    if (press && touch && !press.target.closest('input,textarea,select,[contenteditable="true"],[role="slider"],.track-select')) {
      const dx = touch.clientX - press.x
      if (press.edge && press.direction === 'edge' && dx > 90) {
        suppressUntil = performance.now() + 500
        window.dispatchEvent(new Event('bilimusic-back', { cancelable: true }))
      } else if (press.direction === 'horizontal' && press.x > 28 && press.x < window.innerWidth - 28 && Math.abs(dx) > 65) {
        const panel = press.target.closest('[data-swipe-tabs]')
        if (panel) {
          suppressUntil = performance.now() + 500
          panel.dispatchEvent(new CustomEvent('bilimusic-tab-swipe', { detail: dx < 0 ? 1 : -1 }))
        }
      }
    }
    press = undefined
  }, { passive: true })
  document.addEventListener('gesturestart', event => event.preventDefault())
  document.addEventListener('touchcancel', () => { cancel(); press = undefined }, { passive: true })
  document.addEventListener('click', event => {
    if (performance.now() < suppressUntil && !(event.target as HTMLElement).closest('.action-menu-panel,.track-context-menu')) {
      event.preventDefault(); event.stopImmediatePropagation(); suppressUntil = 0
    }
  }, true)
}
