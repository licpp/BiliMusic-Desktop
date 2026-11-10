import { useLayoutEffect, useRef, type RefObject } from 'react'

export function useLocateCurrentRow(root: RefObject<HTMLElement | null>, open: boolean, rowId?: string) {
  const located = useRef(false)
  useLayoutEffect(() => {
    if (!open) { located.current = false; return }
    if (!rowId || located.current) return
    const frame = requestAnimationFrame(() => {
      const host = root.current
      const row = host?.querySelector<HTMLElement>(`[data-current-row="${CSS.escape(rowId)}"]`)
      const scroller = row?.closest<HTMLElement>('.queue-list, .mobile-page-content, .stage-scroll, .collection-dialog')
      if (!row || !scroller?.clientHeight || !row.getClientRects().length) return
      const viewport = scroller.getBoundingClientRect()
      const bounds = row.getBoundingClientRect()
      if (bounds.top < viewport.top + 8 || bounds.bottom > viewport.bottom - 8) {
        scroller.scrollTop += bounds.top - viewport.top - (scroller.clientHeight - row.offsetHeight) / 2
      }
      located.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [root, open, rowId])
}
