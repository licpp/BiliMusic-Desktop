import { flushSync } from 'react-dom'
import { touchDirection, type TouchDirection } from './touchDirection'
import { isIOS, isMobile } from '../services/platform'
import { dispatchBack, isTopOverlay } from './overlayStack'
import { edgeBackDirection, edgeBackTiming, edgeSwipeOffset, navigationSwipeDirection } from './gestureRelease'
import { stopPageMotion } from './pageMotion'
import { slideNavigation, transformX } from './slideNavigation'
import { holdListUpdates } from './navigationListMotion'
import { isTextEditor } from './nativeTextEditing'

const directControls = '[data-touch-picker],[data-order-editor],[data-swipe-cover],input,select,[role="slider"],.track-select,[data-mini-dock],.dock-track-group,.queue-sheet-handle,.lyrics-close,.comments-sheet-handle,.collection-sheet-handle,.touch-sheet-handle,video'

function horizontallyScrollable(target: Element, surface: HTMLElement) {
  for (let item: Element | null = target; item && item !== surface; item = item.parentElement) {
    if (item.scrollWidth > item.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(item).overflowX)) return true
  }
  return false
}

type TouchPress = {
  x: number
  y: number
  time: number
  edge?: HTMLElement | null
  fallbackBack?: boolean
  tabs?: HTMLElement | null
  row?: HTMLElement | null
  direction: TouchDirection
  dragging?: NavigationDrag
}

type NavigationDrag = {
  owner: HTMLElement
  track: HTMLElement
  back: boolean
  width: number
  base: number
  offset: number
  paintedOffset: number
  sample?: { offset: number; time: number; velocity: number }
  releaseLists: () => void
  frame?: number
  indicator?: { element: HTMLElement; base: number; step: number }
}

function canSlide(owner: HTMLElement, offset: number) {
  return owner.hasAttribute(offset < 0 ? 'data-swipe-next' : 'data-swipe-previous')
}

function indicatorPosition(drag: NavigationDrag, offset: number) {
  const indicator = drag.indicator!
  return indicator.base - (canSlide(drag.owner, offset) ? offset / drag.width : 0) * indicator.step
}

// Use the same touch arbitration for attached menus and page gestures.
export function installMobileGestures() {
  if (!isMobile) return
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let press: TouchPress | undefined
  let menuTimer: ReturnType<typeof setTimeout> | undefined
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined
  let suppressUntil = 0
  const cancelHold = () => {
    clearTimeout(menuTimer)
    clearTimeout(feedbackTimer)
    press?.row?.removeAttribute('data-touch-holding')
  }
  const clearDrag = (direction = 0, velocity = 0) => {
    const drag = press?.dragging
    if (!drag) return
    const { owner, track, back, width, base, indicator, paintedOffset, frame } = drag
    if (frame !== undefined) cancelAnimationFrame(frame)
    let motion: Animation | undefined
    const interrupt = () => {
      motion?.cancel()
      reset()
    }
    const reset = () => {
      owner.removeEventListener('bilimusic-tab-swipe-interrupt', interrupt)
      if (!back) {
        track.style.removeProperty('transform')
        indicator?.element.style.removeProperty('transform')
      }
      owner.removeAttribute('data-navigation-drag')
      owner.removeAttribute('data-swipe-settling')
      track.style.removeProperty('--navigation-drag-x')
    }
    // A portal keeps its current transform and finishes its own exit.
    const portal = back && owner.hasAttribute('data-mobile-page')
    if (portal && direction) {
      dispatchBack({ element: owner, timing: edgeBackTiming(width - paintedOffset, width, velocity) })
      if (owner.hasAttribute('data-page-closing') || !owner.isConnected) { drag.releaseLists(); return }
    }
    const commitTab = !back && direction && canSlide(owner, direction)
    const commitBack = back && !portal && direction
    const advance = commitTab || commitBack
    if (!advance && !paintedOffset) { reset(); drag.releaseLists(); return }
    if (commitTab && !reducedMotion.matches && !owner.hasAttribute('data-navigation-drag')) {
      owner.setAttribute('data-navigation-drag', '')
    }
    owner.setAttribute('data-swipe-settling', '')
    const route = owner.dataset.stageRoute
    const end = advance ? direction * width : 0
    const linked = indicator && {
      element: indicator.element,
      from: indicatorPosition(drag, paintedOffset),
      to: indicatorPosition(drag, end),
    }
    const timing = back ? edgeBackTiming(end - paintedOffset, width, velocity) : advance ? 205 : 175
    motion = slideNavigation(track, base + paintedOffset, base + end, timing, () => {
      if (commitBack && owner.dataset.stageRoute === route) flushSync(() => { dispatchBack() })
      if (commitTab) owner.dispatchEvent(new CustomEvent('bilimusic-tab-swipe', { cancelable: true, detail: -direction }))
      reset()
    }, linked)
    if (motion) void motion.finished.then(drag.releaseLists, drag.releaseLists)
    else drag.releaseLists()
    if (!back && motion) owner.addEventListener('bilimusic-tab-swipe-interrupt', interrupt, { once:true })
  }
  document.addEventListener('touchstart', event => {
    cancelHold()
    clearDrag()
    press = undefined
    if (event.touches.length !== 1) return
    suppressUntil = 0
    const target = event.target
    if (!(target instanceof Element) || isTextEditor(target) || target.closest(`${directControls},[inert]`)) return
    const touch = event.touches[0]
    const fromEdge = isIOS && touch.clientX < 24
    const edgeSurface = fromEdge ? target.closest<HTMLElement>('[data-edge-back]') : null
    const canPop = edgeSurface && (!edgeSurface.matches('[data-mobile-page]') || isTopOverlay(edgeSurface))
    const tabs = target.closest<HTMLElement>('[data-swipe-tabs]') ??
      target.closest<HTMLElement>('[data-main-swipe]')?.querySelector<HTMLElement>('[data-swipe-tabs]')
    const usableTabs = tabs && !horizontallyScrollable(target, tabs) ? tabs : null
    // When on a non-first tab, a right-swipe from the left edge returns to the
    // previous tab instead of popping the whole route.
    const tabOwnsBackSwipe = Boolean(usableTabs?.hasAttribute('data-swipe-previous'))
    const row = target.closest('[data-overflow-panel],.track-context-menu,.icon-action,.action-menu-trigger') ? null :
      target.closest<HTMLElement>('.result-main,.library-entry,.library-track,.video-part-row,.result-card,.queue-entry,.track-row')
    press = { x: touch.clientX, y: touch.clientY, time: event.timeStamp, direction: 'pending', row,
      edge: !tabOwnsBackSwipe && canPop && !horizontallyScrollable(target, edgeSurface) ? edgeSurface : null,
      fallbackBack: fromEdge && !edgeSurface && !usableTabs,
      tabs: usableTabs }
    if (!row) return
    feedbackTimer = setTimeout(() => row.setAttribute('data-touch-holding', ''), 110)
    menuTimer = setTimeout(() => {
      cancelHold()
      suppressUntil = performance.now() + 900
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: touch.clientX, clientY: touch.clientY }))
      press = undefined
    }, 480)
  }, { passive: true })
  document.addEventListener('touchmove', event => {
    const touch = event.touches[0]
    if (event.touches.length !== 1) { cancelHold(); clearDrag(); press = undefined; return }
    if (!press || !touch) return
    const dx = touch.clientX - press.x
    if (Math.hypot(dx, touch.clientY - press.y) > 9) cancelHold()
    press.direction = touchDirection(touch.clientX, touch.clientY, press.x, press.y, press.direction)
    if (press.direction === 'pending' || press.direction === 'vertical') return
    if (!press.dragging) {
      if (press.fallbackBack && press.direction === 'edge' && dx > 0 && event.cancelable) event.preventDefault()
      const back = Boolean(press.edge && press.direction === 'edge' && dx > 0)
      const owner = back ? press.edge : press.tabs
      if (!owner?.isConnected || owner.matches('[data-swipe-settling],[data-page-closing]')) return
      const track = back ? owner.querySelector<HTMLElement>(':scope > [data-edge-track]') ?? owner : owner.querySelector<HTMLElement>(':scope > [data-swipe-track]')
      if (!track) return
      stopPageMotion(track)
      const width = track.getBoundingClientRect().width
      if (!width) return
      const indicator = back ? null : owner.querySelector<HTMLElement>(':scope > .segmented-tabs > [data-swipe-indicator]')
      const step = indicator?.getBoundingClientRect().width || 0
      const index = back ? 0 : Number(owner.style.getPropertyValue('--swipe-index') || 0)
      if (!back) owner.removeAttribute('data-animate-tab-tap')
      press.dragging = { owner, track, back, width, base: -index * width, offset: 0, paintedOffset: 0,
        releaseLists: holdListUpdates(), indicator: indicator && step ? { element: indicator, base: index * step, step } : undefined }
    }
    if (event.cancelable) event.preventDefault()
    const drag = press.dragging
    const { owner, track, back, width, base, indicator } = drag
    const distance = back ? edgeSwipeOffset(dx, width) : dx
    const available = back || canSlide(owner, dx)
    drag.offset = available ? Math.max(-width, Math.min(width, distance)) :
      distance / (4 + Math.abs(distance) / Math.max(1, width) * 12)
    if (back) {
      const sample = drag.sample
      const elapsed = event.timeStamp - (sample?.time ?? press.time)
      const velocity = (drag.offset - (sample?.offset ?? 0)) / Math.max(1, elapsed)
      drag.sample = { offset: drag.offset, time: event.timeStamp, velocity }
    }
    if (drag.frame !== undefined || reducedMotion.matches) return
    drag.frame = requestAnimationFrame(() => {
      drag.frame = undefined
      drag.paintedOffset = drag.offset
      if (!owner.hasAttribute('data-navigation-drag')) owner.setAttribute('data-navigation-drag', '')
      if (back) track.style.setProperty('--navigation-drag-x', `${drag.offset}px`)
      else {
        track.style.transform = transformX(base + drag.offset)
        if (indicator) indicator.element.style.transform = transformX(indicatorPosition(drag, drag.offset))
      }
    })
  }, { passive: false })
  document.addEventListener('touchend', event => {
    cancelHold()
    const touch = event.changedTouches[0]
    if (press?.dragging && touch) {
      const { width, back, sample } = press.dragging
      const velocity = sample && event.timeStamp - sample.time < 80 ? sample.velocity : 0
      const distance = touch.clientX - press.x
      const direction = back ? edgeBackDirection(distance, width, velocity) : navigationSwipeDirection(distance, event.timeStamp - press.time, false, width)
      suppressUntil = performance.now() + 500
      clearDrag(direction, velocity)
    } else if (press?.fallbackBack && press.direction === 'edge' && touch &&
      navigationSwipeDirection(touch.clientX - press.x, event.timeStamp - press.time, true, window.innerWidth) && dispatchBack()) {
      suppressUntil = performance.now() + 500
    }
    press = undefined
  }, { passive: true })
  document.addEventListener('touchcancel', () => { cancelHold(); clearDrag(); press = undefined }, { passive: true })
  document.addEventListener('click', event => {
    if (event.detail && performance.now() < suppressUntil && (event.target as Element).closest && !(event.target as Element).closest('.action-menu-panel,.track-context-menu')) {
      event.preventDefault(); event.stopImmediatePropagation(); suppressUntil = 0
    }
  }, true)
}
