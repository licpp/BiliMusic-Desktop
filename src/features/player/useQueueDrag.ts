import { useLayoutEffect, useRef, type PointerEvent, type RefObject } from 'react'
import { accountEpoch } from '../../services/accountScope'
import type { Track } from '../../domain/track'
import { usePlayerStore } from './playerStore'
import type { QueueReorderScope } from './queueGroups'

type Position = 'before' | 'after'
type Drop = { row: HTMLElement; id: string; position: Position }
type Drag = {
  pointer: number
  account: number
  scope: QueueReorderScope
  ids: string[]
  row: HTMLElement
  block: HTMLElement
  order: string[]
  startY: number
  gripOffset: number
  x: number
  y: number
  offset: number
  active: boolean
  frame?: number
  drop?: Drop
}

function findDrop(list: HTMLElement, drag: Drag, x: number, y: number): Drop | undefined {
  const part = drag.scope === 'part'
  const selector = part ? '[data-queue-part]' : '[data-queue-block]'
  let row = document.elementFromPoint(x, y)?.closest<HTMLElement>(selector)
  const last = list.lastElementChild
  if (!row && !part && last instanceof HTMLElement && y >= last.getBoundingClientRect().bottom) row = last
  if (!row || !list.contains(row) || row === (drag.scope === 'part' ? drag.row : drag.block)) return
  if (drag.scope === 'part' && row.closest('[data-queue-block]') !== drag.block) return
  const id = row.dataset.queuePart ?? row.dataset.queueBlock
  if (!id) return
  const rect = row.getBoundingClientRect()
  return { row, id, position: y < rect.top + rect.height / 2 ? 'before' : 'after' }
}

export function useQueueDrag(root: RefObject<HTMLDivElement | null>, open: boolean, groups: { tracks: Track[] }[]) {
  const current = useRef<Drag | null>(null)

  const finish = () => {
    const drag = current.current
    if (!drag) return
    current.current = null
    if (drag.frame !== undefined) cancelAnimationFrame(drag.frame)
    drag.row.style.removeProperty('--queue-drag-offset')
    delete drag.row.dataset.queueDragging
    if (drag.drop) delete drag.drop.row.dataset.queueDrop
    const list = root.current
    if (list?.hasPointerCapture(drag.pointer)) list.releasePointerCapture(drag.pointer)
    return drag
  }
  useLayoutEffect(() => () => { finish() }, [open])

  const update = (drag: Drag, autoScroll: boolean) => {
    const list = root.current
    if (!list || !list.contains(drag.row) || accountEpoch() !== drag.account) { finish(); return }
    if (!drag.active && Math.abs(drag.y - drag.startY) < 5) return
    drag.active = true
    const bounds = list.getBoundingClientRect()
    const y = Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, drag.y))
    const x = Math.max(bounds.left + 1, Math.min(bounds.right - 1, drag.x))
    const edge = Math.min(44, bounds.height / 4)
    const step = autoScroll && edge > 0 ? 12 * Math.max(-1, Math.min(0, (y - bounds.top - edge) / edge))
      + 12 * Math.min(1, Math.max(0, (y - bounds.bottom + edge) / edge)) : 0
    const previousScroll = list.scrollTop
    if (step) list.scrollTop += step
    const row = drag.row.getBoundingClientRect()
    const top = row.top - drag.offset
    drag.offset = Math.max(bounds.top, Math.min(bounds.bottom - row.height, y - drag.gripOffset)) - top
    drag.row.style.setProperty('--queue-drag-offset', `${drag.offset}px`)
    drag.row.dataset.queueDragging = ''

    const drop = findDrop(list, drag, x, y)
    if (drag.drop?.row !== drop?.row || drag.drop?.position !== drop?.position || drag.drop?.id !== drop?.id) {
      if (drag.drop) delete drag.drop.row.dataset.queueDrop
      if (drop) drop.row.dataset.queueDrop = drop.position
      drag.drop = drop
    }
    if (list.scrollTop !== previousScroll) schedule(drag)
  }

  const schedule = (drag: Drag) => {
    if (drag.frame !== undefined) return
    drag.frame = requestAnimationFrame(() => {
      drag.frame = undefined
      update(drag, true)
    })
  }

  return {
    start(event: PointerEvent<HTMLButtonElement>, ids: string[], scope: QueueReorderScope) {
      const list = root.current
      const row = event.currentTarget.closest<HTMLElement>('.queue-entry')
      const block = row?.closest<HTMLElement>('[data-queue-block]')
      if (!open || !list || !row || !block || current.current || event.button !== 0 || !event.isPrimary) return
      event.preventDefault()
      event.stopPropagation()
      list.setPointerCapture(event.pointerId)
      current.current = {
        pointer: event.pointerId, account: accountEpoch(), scope, ids, row, block,
        order: usePlayerStore.getState().queue.map(track => track.id),
        startY: event.clientY, y: event.clientY, x: event.clientX, offset: 0, active: false,
        gripOffset: event.clientY - row.getBoundingClientRect().top,
      }
    },
    events: {
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const drag = current.current
        if (!drag || drag.pointer !== event.pointerId) return
        drag.x = event.clientX
        drag.y = event.clientY
        schedule(drag)
      },
      onPointerUp(event: PointerEvent<HTMLDivElement>) {
        const pending = current.current
        if (!pending || pending.pointer !== event.pointerId) return
        pending.x = event.clientX
        pending.y = event.clientY
        update(pending, false)
        const drag = finish()
        if (!drag?.drop) return
        const state = usePlayerStore.getState()
        if (state.queue.length !== drag.order.length || state.queue.some((track, index) => track.id !== drag.order[index])) return
        const { id, position } = drag.drop
        const target = drag.scope === 'group' ? groups.find(group => group.tracks[0].id === id)?.tracks.map(track => track.id) : [id]
        if (target) state.reorderQueueRows(drag.ids, target, position, drag.scope)
      },
      onPointerCancel(event: PointerEvent<HTMLDivElement>) { if (current.current?.pointer === event.pointerId) finish() },
      onLostPointerCapture(event: PointerEvent<HTMLDivElement>) { if (current.current?.pointer === event.pointerId) finish() },
    },
  }
}
