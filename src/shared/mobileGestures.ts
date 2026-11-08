import { isMobile } from '../services/platform'

// Delegate long presses so every existing row context menu has the same touch
// semantics. Scrolling cancels the press; the release never becomes a play tap.
export function installMobileGestures() {
  if (!isMobile) return
  let press: { x: number; y: number; target: HTMLElement; edge: boolean } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let suppressUntil = 0
  const cancel = () => { clearTimeout(timer); timer = undefined }
  document.addEventListener('touchstart', event => {
    cancel()
    suppressUntil = 0
    if (event.touches.length !== 1) { press = undefined; return }
    const target = event.target as HTMLElement
    const touch = event.touches[0]
    press = { x: touch.clientX, y: touch.clientY, target, edge: touch.clientX < 24 }
    if (target.closest('input,textarea,select,[data-overflow-panel],.track-context-menu')) return
    const row = target.closest<HTMLElement>('.library-entry,.library-track,.video-part-row,.result-card,.queue-entry,.track-row')
    if (!row || target.closest('.icon-action,.action-menu-trigger')) return
    timer = setTimeout(() => {
      suppressUntil = performance.now() + 900
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: touch.clientX, clientY: touch.clientY }))
      press = undefined
    }, 480)
  }, { passive: true })
  document.addEventListener('touchmove', event => {
    if (!press) return
    const touch = event.touches[0]
    if (!touch || Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 9) cancel()
  }, { passive: true })
  document.addEventListener('touchend', event => {
    cancel()
    const touch = event.changedTouches[0]
    if (press?.edge && touch && touch.clientX - press.x > 90 && Math.abs(touch.clientY - press.y) < 45 && !press.target.closest('input,textarea,[role="slider"]')) {
      suppressUntil = performance.now() + 500
      window.dispatchEvent(new Event('bilimusic-back', { cancelable: true }))
    }
    press = undefined
  }, { passive: true })
  document.addEventListener('touchcancel', () => { cancel(); press = undefined }, { passive: true })
  document.addEventListener('click', event => {
    if (performance.now() < suppressUntil && !(event.target as HTMLElement).closest('.action-menu-panel,.track-context-menu')) {
      event.preventDefault(); event.stopImmediatePropagation(); suppressUntil = 0
    }
  }, true)
}
