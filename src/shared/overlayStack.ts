import type { SlideTiming } from './slideNavigation'

type BackSlide = { element: HTMLElement; timing: SlideTiming }
type Overlay = { element: HTMLElement; dismiss: (timing?: SlideTiming) => void }
const layers: Overlay[] = []

export function registerOverlay(element: HTMLElement, dismiss: Overlay['dismiss'], raise = false) {
  if (raise) {
    let z = 400
    for (const other of layers) {
      const value = Number.parseInt(getComputedStyle(other.element).zIndex, 10)
      if (Number.isFinite(value)) z = Math.max(z, value + 2)
    }
    element.style.zIndex = String(z)
  }
  const layer = { element, dismiss }
  layers.push(layer)
  return () => {
    const index = layers.indexOf(layer)
    if (index >= 0) layers.splice(index, 1)
  }
}

export function isTopOverlay(element: HTMLElement | null) {
  return element === layers.at(-1)?.element
}

export function dispatchBack(slide?: BackSlide) {
  return !window.dispatchEvent(slide
    ? new CustomEvent<BackSlide>('bilimusic-back', { cancelable: true, detail: slide })
    : new Event('bilimusic-back', { cancelable: true }))
}

export function installOverlayBack() {
  window.addEventListener('bilimusic-back', event => {
    if (event.defaultPrevented) return
    const layer = layers.at(-1)
    if (!layer) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const slide = (event as CustomEvent<BackSlide>).detail
    layer.dismiss(slide?.element === layer.element ? slide.timing : undefined)
  })
}

const locks = new WeakMap<HTMLElement, { count: number; original: boolean }>()
export function lockDialogBackground(root: HTMLElement) {
  const state = locks.get(root) || { count: 0, original: Boolean(root.hasAttribute?.('inert') || root.inert) }
  state.count++
  locks.set(root, state)
  root.toggleAttribute?.('inert', true)
  root.inert = true
  let released = false
  return () => {
    if (released) return
    released = true
    if (--state.count !== 0) return
    root.toggleAttribute?.('inert', state.original)
    root.inert = state.original
    locks.delete(root)
  }
}

export function lockAppForPortal() {
  const root = document.getElementById('root')
  return root ? lockDialogBackground(root) : () => {}
}
