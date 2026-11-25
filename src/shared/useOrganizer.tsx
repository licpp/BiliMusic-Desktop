import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Check, GripVertical, ListFilter, LoaderCircle, X } from 'lucide-react'
import { accountEpoch } from '../services/accountScope'
import { useListPreferences, useSaveListPreferences } from '../services/listPreferences'
import { rankChanges } from '../services/listOrdering'
import { commandErrorMessage } from '../services/desktopApi'
import '../styles/list-organizer.css'

type OrganizeItem = { id: string; name: string; group?: string }
type SaveOrder = (expected: string[], ordered: string[]) => Promise<void>
type Draft = { items: OrganizeItem[]; expected: string[]; epoch: number }
type Drag = { id: string; pointer: number; x: number; y: number; offsetX: number; offsetY: number }

export function useOrganizer(items: OrganizeItem[], label: string, options: { saveOrder?: SaveOrder; expected?: string[] } = {}) {
  const query = useListPreferences(), savePreferences = useSaveListPreferences()
  const [draft, setDraft] = useState<Draft>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [dragging, setDragging] = useState<string>()
  const operation = useRef<Draft | undefined>(undefined)
  const root = useRef<HTMLElement | null>(null)
  const positions = useRef(new Map<HTMLElement, DOMRect>())
  const drag = useRef<Drag | undefined>(undefined)
  const canEdit = items.length >= 2 && (Boolean(options.saveOrder) || !query.isPending)
  const renderedRows = () => root.current?.querySelectorAll<HTMLElement>('[data-order-row]')
  const remember = () => {
    positions.current.clear()
    renderedRows()?.forEach(row => {
      if (row.dataset.orderRow !== drag.current?.id) positions.current.set(row, row.getBoundingClientRect())
    })
  }
  const follow = () => {
    const pointer = drag.current
    if (!pointer) return
    const row = root.current?.querySelector<HTMLElement>('[data-order-dragging]')
    if (!row) return
    const bounds = row.getBoundingClientRect()
    const left = bounds.left - (parseFloat(row.style.getPropertyValue('--order-drag-x')) || 0)
    const top = bounds.top - (parseFloat(row.style.getPropertyValue('--order-drag-y')) || 0)
    row.style.setProperty('--order-drag-x', `${pointer.x - pointer.offsetX - left}px`)
    row.style.setProperty('--order-drag-y', `${pointer.y - pointer.offsetY - top}px`)
  }
  useLayoutEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    renderedRows()?.forEach(row => {
      row.getAnimations?.().forEach(animation => animation.cancel())
      if (row.dataset.orderRow === drag.current?.id) return
      const previous = positions.current.get(row)
      const current = row.getBoundingClientRect()
      if (!reduced && previous && (Math.abs(previous.left - current.left) > 1 || Math.abs(previous.top - current.top) > 1)) {
        row.animate?.([
          { transform: `translate(${previous.left - current.left}px, ${previous.top - current.top}px)` },
          { transform: 'translate(0, 0)' },
        ], { duration: 180, easing: 'cubic-bezier(.2,.75,.25,1)' })
      }
    })
    positions.current.clear()
    follow()
  }, [draft, dragging])

  const endDrag = () => {
    const row = root.current?.querySelector<HTMLElement>('[data-order-dragging]')
    row?.style.removeProperty('--order-drag-x')
    row?.style.removeProperty('--order-drag-y')
    drag.current = undefined
    setDragging(undefined)
  }
  const cancel = () => {
    operation.current = undefined
    endDrag()
    setDraft(undefined); setError(''); setBusy(false)
  }
  useEffect(() => {
    window.addEventListener('bilimusic-account-changing', cancel)
    return () => {
      operation.current = undefined
      window.removeEventListener('bilimusic-account-changing', cancel)
    }
  }, [])
  const start = () => {
    const next = { items, expected: options.expected ?? items.map(item => item.id), epoch: accountEpoch() }
    operation.current = next
    setDraft(next)
    setError('')
  }
  const finish = async () => {
    if (!draft || busy || drag.current) return
    const token = operation.current
    if (!token) return
    const current = () => operation.current === token && token.epoch === accountEpoch()
    const before = options.expected ?? items.map(item => item.id)
    if (!current() || before.length !== token.expected.length || !token.expected.every((id, index) => id === before[index])) {
      setError('列表已变化，请取消后重新整理')
      return
    }
    if (draft === token) { cancel(); return }
    setBusy(true); setError('')
    try {
      const ordered = draft.items.map(item => item.id)
      if (options.saveOrder) await options.saveOrder(token.expected, ordered)
      else {
        const changes = rankChanges(ordered, query.data?.preferences || [])
        if (changes.length) await savePreferences(changes)
      }
      if (current()) cancel()
    } catch (cause) {
      if (current()) setError(commandErrorMessage(cause))
    } finally {
      if (current()) setBusy(false)
    }
  }
  const move = (id: string, destination: string) => {
    if (!draft || id === destination) return
    const from = draft.items.findIndex(item => item.id === id)
    const to = draft.items.findIndex(item => item.id === destination)
    if (from < 0 || to < 0 || draft.items[from].group !== draft.items[to].group) return
    remember()
    const next = [...draft.items]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setDraft({ ...draft, items: next })
  }
  const pointerMove = (event: PointerEvent<HTMLElement>) => {
    const pointer = drag.current
    if (!pointer || pointer.pointer !== event.pointerId) return
    pointer.x = event.clientX; pointer.y = event.clientY
    follow()
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-order-row]')
    if (target?.closest('[data-order-list]') === event.currentTarget && target.dataset.orderRow) {
      // Once a row has moved across the target, a stationary pointer stays in its new slot.
      const bounds = target.getBoundingClientRect()
      const source = event.currentTarget.querySelector<HTMLElement>('[data-order-dragging]')
      if (source && (source.offsetTop === target.offsetTop
        ? (source.offsetLeft < target.offsetLeft ? event.clientX >= bounds.left + bounds.width / 2 : event.clientX <= bounds.right - bounds.width / 2)
        : (source.offsetTop < target.offsetTop ? event.clientY >= bounds.top + bounds.height / 2 : event.clientY <= bounds.bottom - bounds.height / 2))) {
        move(pointer.id, target.dataset.orderRow)
      }
    }
    const scroller = event.currentTarget.closest<HTMLElement>('.library-panel, .stage-scroll, .swipe-pages-fill .swipe-pane-content, .large-main')
    if (scroller) {
      const bounds = scroller.getBoundingClientRect()
      if (event.clientY < bounds.top + 48) scroller.scrollTop -= 14
      else if (event.clientY > bounds.bottom - 48) scroller.scrollTop += 14
    }
  }
  const draftById = new Map<string, { group?: string; index: number; name: string }>()
  const groupIds = new Map<string | undefined, string[]>()
  for (const { id, group, name } of draft?.items ?? []) {
    const peers = groupIds.get(group) ?? []
    draftById.set(id, { group, name, index: peers.length })
    peers.push(id)
    groupIds.set(group, peers)
  }
  return {
    editing: Boolean(draft),
    cancel,
    error,
    // Preserve slots of fixed entries (e.g. linked folders between folders and collections).
    order: <T,>(rows: T[], key: (row: T) => string): T[] => {
      if (!draft) return rows
      const byId = new Map(rows.map(row => [key(row), row]))
      const byGroup = new Map([...groupIds].map(([group, ids]) => [group, ids.filter(id => byId.has(id))]))
      const indices = new Map<string | undefined, number>()
      return rows.map(row => {
        const item = draftById.get(key(row))
        if (!item) return row
        const index = indices.get(item.group) ?? 0
        indices.set(item.group, index + 1)
        const id = byGroup.get(item.group)?.[index]
        return id === undefined ? row : byId.get(id) ?? row
      })
    },
    listProps: {
      'data-order-list': draft ? '' : undefined,
      onPointerMove: draft ? pointerMove : undefined,
      onPointerUp: (event: PointerEvent<HTMLElement>) => { if (event.pointerId === drag.current?.pointer) endDrag() },
      onPointerCancel: (event: PointerEvent<HTMLElement>) => { if (event.pointerId === drag.current?.pointer) endDrag() },
      onLostPointerCapture: (event: PointerEvent<HTMLElement>) => { if (event.pointerId === drag.current?.pointer) endDrag() },
    },
    rowProps: (id: string) => ({
      'data-order-row': draftById.has(id) ? id : undefined,
      'data-order-dragging': dragging === id ? '' : undefined,
    }),
    handle: (id: string, className = 'action-menu-trigger') => {
      const item = draftById.get(id)
      if (!item || !draft) return
      const peers = groupIds.get(item.group)!
      const list = (element: HTMLElement) => element.closest<HTMLElement>('[data-order-list]')
      const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : 0
        if (!step) return
        event.preventDefault(); event.stopPropagation()
        root.current = list(event.currentTarget)
        const destination = peers[item.index + step]
        if (destination) move(id, destination)
      }
      return <button type="button" className={`${className} order-drag-handle`} disabled={busy || peers.length < 2} title="拖动调整顺序"
        aria-label={`调整 ${item.name} 的顺序`} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight" onKeyDown={onKeyDown}
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0 || drag.current) return
          root.current = list(event.currentTarget)
          const row = event.currentTarget.closest<HTMLElement>('[data-order-row]')
          if (!row || !root.current) return
          const box = row.getBoundingClientRect()
          drag.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, offsetX: event.clientX - box.left, offsetY: event.clientY - box.top }
          root.current.setPointerCapture(event.pointerId)
          setDragging(id)
        }}><GripVertical size={18}/></button>
    },
    controls: <span className="organizer-controls" data-editing={Boolean(draft)}>{draft ? <>
      <button type="button" title="取消整理" aria-label="取消整理" disabled={busy} onClick={cancel}><X size={17}/></button>
      <button type="button" className="organizer-done" title="完成整理" aria-label="完成整理" disabled={busy} onClick={() => void finish()}>{busy ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>}</button>
    </> : <button type="button" title={label} aria-label={label} disabled={!canEdit} onClick={start}><ListFilter size={18}/></button>}</span>,
  }
}
export type Organizer = ReturnType<typeof useOrganizer>
