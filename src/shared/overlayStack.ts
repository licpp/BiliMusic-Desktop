const layers: HTMLElement[] = []
// Portals escape their owner's stacking context. Place a child menu above its
// owner and all currently open dialogs, rather than guessing a fixed z-index.
export function registerOverlay(element: HTMLElement) {
  let z = 400
  for (const other of document.querySelectorAll<HTMLElement>('.dialog-backdrop,.lyric-chooser-backdrop,[data-mobile-page],.comments-sheet-overlay,.action-menu-portal,.track-context-menu')) {
    if (other === element || !other.getClientRects().length) continue
    const value = Number.parseInt(getComputedStyle(other).zIndex, 10)
    if (Number.isFinite(value)) z = Math.max(z, value + 2)
  }
  element.style.zIndex = String(z)
  layers.push(element)
  return () => { const index = layers.indexOf(element); if (index >= 0) layers.splice(index, 1) }
}
export function isTopOverlay(element: HTMLElement | null) { return element === layers.at(-1) }
