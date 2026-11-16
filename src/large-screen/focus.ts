export type FocusRect = { id: string; left: number; top: number; width: number; height: number; primary?: boolean }
export type Direction = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

// Prefer a neighbour in the same row/column before moving to another region.
export function nextFocus(current: FocusRect, candidates: FocusRect[], direction: Direction) {
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight'
  const sign = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1
  const center = (r: FocusRect) => [r.left + r.width / 2, r.top + r.height / 2]
  const [cx, cy] = center(current)
  return candidates.filter(r => r.id !== current.id && r.width > 0 && r.height > 0).map(r => {
    const [x, y] = center(r), primary = horizontal ? (x - cx) * sign : (y - cy) * sign
    const cross = horizontal ? Math.abs(y - cy) : Math.abs(x - cx)
    const overlap = horizontal ? Math.min(current.top + current.height, r.top + r.height) - Math.max(current.top, r.top) : Math.min(current.left + current.width, r.left + r.width) - Math.max(current.left, r.left)
    return { id: r.id, primary, score: primary + cross * 3 + (overlap > 0 ? 0 : 1000) }
  }).filter(r => r.primary > 1).sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))[0]?.id
}

// Vertical navigation follows the next visual row, even when its controls are
// indented. Distance scoring alone skips a settings section for a footer button.
export function nextRowFocus(current: FocusRect, candidates: FocusRect[], direction: 'ArrowUp' | 'ArrowDown') {
  const sign = direction === 'ArrowUp' ? -1 : 1, cy = current.top + current.height / 2, cx = current.left + current.width / 2
  const below = candidates.filter(r => r.id !== current.id && r.width > 0 && r.height > 0).map(r => ({ r, y: r.top + r.height / 2, x: r.left + r.width / 2 })).filter(p => (p.y - cy) * sign > Math.min(current.height, p.r.height) * .55).sort((a, b) => (a.y - b.y) * sign)
  const first = below[0]
  if (!first) return
  return below.filter(p => Math.abs(p.y - first.y) <= Math.min(first.r.height, p.r.height) * .45).sort((a, b) => Number(Boolean(b.r.primary)) - Number(Boolean(a.r.primary)) || Math.abs(a.x - cx) - Math.abs(b.x - cx) || a.r.id.localeCompare(b.r.id))[0]?.r.id
}

// Transfer between the rail/content/dock by the nearest visible screen position,
// not DOM order or the currently selected page in the rail.
export function nearestRegionFocus(current: FocusRect, candidates: FocusRect[]) {
  const cy = current.top + current.height / 2, cx = current.left + current.width / 2
  return candidates.filter(r => r.width > 0 && r.height > 0).sort((a, b) =>
    Math.abs(a.top + a.height / 2 - cy) - Math.abs(b.top + b.height / 2 - cy) ||
    Math.abs(a.left + a.width / 2 - cx) - Math.abs(b.left + b.width / 2 - cx) || a.id.localeCompare(b.id))[0]?.id
}

export const focusSelector = 'button:not(:disabled),input:not(:disabled),summary,a[href],[tabindex="0"]'
export function focusable(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusSelector)].filter(el => el.tabIndex >= 0 && !el.closest('[hidden],[inert],[aria-hidden="true"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
}

export function installDirectionalFocus(options: { onEdit?: () => void } = {}) {
  let lastMain: HTMLElement | undefined
  let lastPlayer: HTMLElement | undefined
  let lastHeader: HTMLElement | undefined
  const remember = (event: FocusEvent) => { const el = event.target as HTMLElement; if (el.closest('.large-main') && !el.closest('[aria-modal="true"]')) lastMain = el; if (el.closest('.large-player-info,.large-lyrics') && !el.closest('[aria-modal="true"]')) lastPlayer = el; if (el.closest('.large-player-header') && !el.closest('[aria-modal="true"]')) lastHeader = el }
  const regionSelector = '.large-nav,.large-dock,.large-player-header,.large-player-info,.large-lyrics,.large-player-footer,.large-resume,.large-home-shortcuts'
  const editable = (target: HTMLElement) => target.matches('input:not([type="range"]):not([type="checkbox"]),textarea,[contenteditable="true"]')
  const pointer = (event: PointerEvent) => { const target = event.target as HTMLElement; if (editable(target)) target.dataset.largeEditing = 'true' }
  const blur = (event: FocusEvent) => { delete (event.target as HTMLElement).dataset.largeEditing }
  const back = (event: Event) => { const target = document.activeElement as HTMLElement; if (target && editable(target) && target.dataset.largeEditing) { delete target.dataset.largeEditing; event.preventDefault(); event.stopImmediatePropagation() } }
  const keydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement
    if (editable(target)) {
      if (event.key === 'Enter' && !target.dataset.largeEditing) { event.preventDefault(); target.dataset.largeEditing = 'true'; options.onEdit?.(); return }
      if (event.key === 'Escape' && target.dataset.largeEditing) {
        delete target.dataset.largeEditing; event.preventDefault(); event.stopPropagation()
        if (document.documentElement.dataset.keyboardOpen) window.dispatchEvent(new Event('bilimusic-back', { cancelable: true }))
        return
      }
      if (event.key === 'Enter' || event.key.length === 1 && !event.ctrlKey && !event.metaKey) target.dataset.largeEditing = 'true'
      if (event.key !== 'Tab' && document.documentElement.dataset.keyboardOpen) return
      if (target.dataset.largeEditing && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    }
    if (event.defaultPrevented || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(event.key)) return
    if (target.matches('input[type="range"]') && !target.closest('.large-progress') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    if (event.key !== 'Tab' && target.matches('select')) return
    const scopes = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"],[data-overflow-panel]')].filter(el => el.getClientRects().length)
    const scope = scopes.at(-1) || document.querySelector<HTMLElement>('.large-shell')
    if (!scope) return
    const elements = focusable(scope)
    if (!elements.length) return
    event.preventDefault()
    if (event.key === 'Tab') {
      const index = elements.indexOf(target)
      elements[(index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length].focus()
      return
    }
    const current = elements.includes(target) ? target : elements[0]
    const explicit = current.getAttribute(`data-focus-${event.key.slice(5).toLowerCase()}`)
    if (explicit) {
      const destination = elements.find(el => el.dataset.focus === explicit)
      if (destination) { destination.focus(); return }
    }
    const main = document.querySelector<HTMLElement>('.large-main'), nav = document.querySelector<HTMLElement>('.large-nav'), dock = document.querySelector<HTMLElement>('.large-dock')
    const modal = scope !== document.querySelector('.large-shell')
    const region = current.closest<HTMLElement>(regionSelector) || (main?.contains(current) ? main : scope)
    if (!modal && (region.matches('.large-player-header') || region.matches('.large-player-footer')) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      // Clipped lyric rows still have DOM rectangles, sometimes level with the
      // footer. A toolbar follows its visible controls, never those rectangles.
      const controls = elements.filter(el => region.contains(el))
      controls[controls.indexOf(current) + (event.key === 'ArrowRight' ? 1 : -1)]?.focus()
      return
    }
    const origin = { id: String(elements.indexOf(current)), ...pickRect(current) }
    const transfer = (items: HTMLElement[]) => {
      const visible = items.filter(el => { const r = el.getBoundingClientRect(), area = main?.getBoundingClientRect(); return !area || r.bottom > area.top && r.top < area.bottom })
      const next = nearestRegionFocus(origin, (visible.length ? visible : items).map(el => ({ id: String(elements.indexOf(el)), ...pickRect(el) })))
      if (next !== undefined) elements[Number(next)].focus()
    }
    const enterHeader = () => {
      const items = elements.filter(el => el.closest('.large-player-header'))
      if (lastHeader?.isConnected && items.includes(lastHeader)) lastHeader.focus()
      else transfer(items)
    }
    if (!modal && region.matches('.large-lyrics') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      // Lyric rows scroll independently: nearby controls need not overlap the
      // selected line vertically. Always provide a route out of this column.
      const media = elements.filter(el => el.closest('.large-player-info'))
      if (event.key === 'ArrowLeft' && media.length) transfer(media)
      else enterHeader()
      return
    }
    if (!modal && region.matches('.large-player-info') && current.dataset.focus === 'playback-seek' && event.key === 'ArrowUp') {
      enterHeader(); return
    }
    if (!modal && region.matches('.large-player-header') && event.key === 'ArrowDown') {
      const items = elements.filter(el => el.closest('.large-player-info,.large-lyrics'))
      const next = nextFocus(origin, items.map(el => ({ id: String(elements.indexOf(el)), ...pickRect(el) })), 'ArrowDown')
      if (next !== undefined) elements[Number(next)].focus()
      return
    }
    // The last rail item connects directly to the song card, regardless of how
    // many settings or list rows exist in the independently scrolling content.
    if (!modal && region === nav && event.key === 'ArrowDown' && current === focusable(nav!).at(-1) && dock) {
      focusable(dock)[0]?.focus(); return
    }
    if (!modal && region === nav && event.key === 'ArrowRight' && main) {
      const items = elements.filter(el => main.contains(el) && !el.closest('.large-topbar'))
      const search = items.find(el => el.dataset.focus === 'search-input')
      if (search) search.focus()
      else if (lastMain?.isConnected && items.includes(lastMain)) lastMain.focus()
      else transfer(items)
      return
    }
    if (!modal && region === dock && event.key === 'ArrowUp') {
      if (lastMain?.isConnected && elements.includes(lastMain)) lastMain.focus()
      else if (main) transfer(elements.filter(el => main.contains(el)))
      return
    }
    if (!modal && region.matches('.large-player-footer') && event.key === 'ArrowUp') {
      if (lastPlayer?.isConnected && elements.includes(lastPlayer)) lastPlayer.focus()
      else transfer(elements.filter(el => el.closest('.large-player-info,.large-lyrics')))
      return
    }
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown'
    const candidates = vertical ? elements.filter(el => region.contains(el)) : elements.filter(el => {
      if (modal) return true
      if (region === nav || region === dock) return region.contains(el)
      if (nav?.contains(el) || dock?.contains(el)) return false
      const rect = pickRect(el)
      return Math.min(rect.top + rect.height, origin.top + origin.height) > Math.max(rect.top, origin.top)
    })
    const rects = candidates.map(el => ({ id: String(elements.indexOf(el)), ...pickRect(el) }))
    let next = vertical ? nextRowFocus(origin, rects, event.key as 'ArrowUp' | 'ArrowDown') : nextFocus(origin, rects, event.key as Direction)
    if (next === undefined && vertical && !modal && region !== nav && region !== main && main?.contains(region)) {
      if (event.key === 'ArrowDown' && region.matches('.large-player-info,.large-lyrics')) {
        transfer(elements.filter(el => el.closest('.large-player-footer'))); return
      }
      if (event.key === 'ArrowUp' && region.matches('.large-player-info,.large-lyrics')) {
        enterHeader(); return
      }
      // Other nested regions return to their containing page's controls.
      const parent = elements.filter(el => main.contains(el) && !el.closest(regionSelector)).map(el => ({ id: String(elements.indexOf(el)), ...pickRect(el) }))
      next = nextRowFocus(origin, parent, event.key as 'ArrowUp' | 'ArrowDown')
    }
    if (next !== undefined) elements[Number(next)].focus()
    else if (!modal && region !== nav && event.key === 'ArrowLeft' && nav) transfer(elements.filter(el => nav.contains(el) && el.hasAttribute('data-focus')))
    else if (!modal && region === main && event.key === 'ArrowDown') focusable(dock || document.createElement('div'))[0]?.focus()
    else if (!elements.includes(target)) current.focus()
  }
  document.addEventListener('keydown', keydown)
  document.addEventListener('pointerdown', pointer)
  document.addEventListener('focusout', blur)
  document.addEventListener('focusin', remember)
  window.addEventListener('bilimusic-back', back, true)
  return () => { document.removeEventListener('keydown', keydown); document.removeEventListener('pointerdown', pointer); document.removeEventListener('focusout', blur); document.removeEventListener('focusin', remember); window.removeEventListener('bilimusic-back', back, true) }
}
function pickRect(el: HTMLElement) { const { left, top, width, height } = el.getBoundingClientRect(); return { left, top, width, height, primary: el.hasAttribute('data-primary-focus') } }
