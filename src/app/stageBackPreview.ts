type Preview = { frame: HTMLElement; scroll: Array<[HTMLElement, number, number]> }

// Keep the last visible layout as an inert underlay. React keeps ownership of
// the actual route and restores its scroll and focus when navigation commits.
export function captureStagePreview(source: HTMLElement | null): Preview | undefined {
  if (!source) return
  const frame = source.cloneNode(false) as HTMLElement
  const scroll: Preview['scroll'] = []
  const excluded = '[hidden], [inert], [role="dialog"], [role="menu"]'
  const prepare = (node: HTMLElement, copy: HTMLElement) => {
    if (node.scrollTop || node.scrollLeft) scroll.push([copy, node.scrollLeft, node.scrollTop])
    copy.removeAttribute('id')
    if (node instanceof HTMLImageElement && node.complete && node.naturalWidth && copy instanceof HTMLImageElement) copy.loading = 'eager'
  }
  // Hidden stage pages can hold long lists. Leave them out before cloning.
  for (const child of source.children) {
    if (child.matches(excluded)) continue
    const copy = child.cloneNode(true) as HTMLElement
    const copies = copy.querySelectorAll<HTMLElement>('*')
    prepare(child as HTMLElement, copy)
    child.querySelectorAll<HTMLElement>('*').forEach((node, index) => prepare(node, copies[index]))
    copy.querySelectorAll(excluded).forEach(node => node.remove())
    frame.append(copy)
  }
  return { frame, scroll }
}

export function mountStagePreview(host: HTMLElement, preview?: Preview) {
  host.replaceChildren(...(preview ? [preview.frame] : []))
  for (const [node, x, y] of preview?.scroll || []) {
    node.scrollLeft = x
    node.scrollTop = y
  }
}
