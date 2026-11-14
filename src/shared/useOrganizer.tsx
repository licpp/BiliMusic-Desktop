import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { ArrowDown, ArrowUp, Check, Folder, GripVertical, Link2, ListFilter, ListMusic, LoaderCircle, X } from 'lucide-react'
import { accountEpoch } from '../services/accountScope'
import { useListPreferences, useSaveListPreferences } from '../services/listPreferences'
import { rankChanges } from '../services/listOrdering'
import { commandErrorMessage } from '../services/desktopApi'
import { Artwork } from './Artwork'
import '../styles/list-organizer.css'

export type OrganizeItem = { id: string; name: string; group?: string; coverUrl?: string; kind?: 'folder' | 'linked' | 'playlist' }
export function useOrganizer(items: OrganizeItem[], label = '整理') {
  const query = useListPreferences(), save = useSaveListPreferences()
  const [draft, setDraft] = useState<OrganizeItem[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [dragging, setDragging] = useState<string>()
  const editor = useRef<HTMLDivElement>(null), positions = useRef(new Map<string, DOMRect>())
  const scope = useRef(0), fingerprint = useRef('')
  const drag = useRef<{ id: string; pointer: number; offset: number; y: number } | null>(null)
  const signature = items.map(item => item.id).sort().join('\n')
  const remember = () => {
    positions.current.clear()
    editor.current?.querySelectorAll<HTMLElement>('[data-order-row]').forEach(row => positions.current.set(row.dataset.orderRow!, row.getBoundingClientRect()))
  }
  const follow = () => {
    if (!drag.current) return
    const row = [...(editor.current?.querySelectorAll<HTMLElement>('[data-order-row]') || [])].find(row => row.dataset.orderRow === drag.current?.id)
    if (!row) return
    const shift = parseFloat(row.style.getPropertyValue('--order-drag-y')) || 0
    const top = row.getBoundingClientRect().top - shift
    editor.current?.style.setProperty('--order-slot-top', `${row.offsetTop}px`)
    editor.current?.style.setProperty('--order-slot-height', `${row.offsetHeight}px`)
    row.style.setProperty('--order-drag-y', `${drag.current.y - drag.current.offset - top}px`)
  }
  useLayoutEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    editor.current?.querySelectorAll<HTMLElement>('[data-order-row]').forEach(row => {
      row.getAnimations().forEach(animation => animation.cancel())
      if (row.dataset.orderRow === drag.current?.id) return
      row.style.removeProperty('--order-drag-y')
      const previous = positions.current.get(row.dataset.orderRow!), current = row.getBoundingClientRect()
      if (!reduced && previous && Math.abs(previous.top - current.top) > 1) row.animate([
        { transform: `translateY(${previous.top - current.top}px)` }, { transform: 'translateY(0)' },
      ], { duration: 180, easing: 'cubic-bezier(.2,.75,.25,1)' })
    })
    follow()
    positions.current.clear()
  }, [draft, dragging])
  const move = (id: string, destination: string) => {
    if (!draft || id === destination) return
    const from = draft.findIndex(item => item.id === id), to = draft.findIndex(item => item.id === destination)
    if (from < 0 || to < 0 || draft[from].group !== draft[to].group) return
    remember()
    const next = [...draft], item = next.splice(from, 1)[0]
    next.splice(to, 0, item); setDraft(next)
  }
  const endDrag = () => { remember(); drag.current = null; setDragging(undefined) }
  const cancel = () => { drag.current = null; setDragging(undefined); setDraft(null); setError('') }
  const finish = async () => {
    if (!draft) return
    if (scope.current !== accountEpoch() || fingerprint.current !== signature) { setError('列表已变化，请取消后重新整理'); return }
    setBusy(true); setError('')
    try { const changes = rankChanges(draft.map(item => item.id), query.data?.preferences || []); if (changes.length) await save(changes); cancel() }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    drag.current.y = event.clientY
    follow()
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-order-row]')
    if (row?.closest('[data-order-editor]') === editor.current && row?.dataset.orderRow) {
      const item = draft?.find(item => item.id === row.dataset.orderRow)
      const active = draft?.find(item => item.id === drag.current?.id)
      if (item?.group === active?.group) { move(drag.current.id, row.dataset.orderRow) }
    }
    // The sidebar itself scrolls; do not scroll the unrelated main content.
    let scroller = editor.current?.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    if (scroller) { const rect = scroller.getBoundingClientRect(); if (event.clientY < rect.top + 48) scroller.scrollTop -= 14; else if (event.clientY > rect.bottom - 48) scroller.scrollTop += 14 }
  }
  return {
    editing: !!draft,
    controls: <span className="organizer-controls">{draft ? <>
      <button type="button" title="取消整理" aria-label="取消整理" disabled={busy} onClick={cancel}><X size={16}/><span className="organizer-label">取消</span></button>
      <button type="button" className="organizer-done" title="完成整理" aria-label="完成整理" disabled={busy} onClick={() => void finish()}>{busy ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>}<span className="organizer-label">完成</span></button>
    </> : <button type="button" title={label} aria-label={label} disabled={items.length < 2 || query.isPending} onClick={() => { scope.current = accountEpoch(); fingerprint.current = signature; setDraft(items); setError('') }}><ListFilter size={16}/><span className="organizer-label">整理</span></button>}</span>,
    editor: <>{error && <p className="inline-error" role="alert">{error}</p>}{draft && <div className="order-editor" ref={editor} data-order-editor data-drag-active={!!dragging}
      onPointerMove={pointerMove} onPointerUp={() => { if (drag.current) endDrag() }} onPointerCancel={() => { if (drag.current) endDrag() }} onLostPointerCapture={() => { if (drag.current) endDrag() }}>
      <p className="order-editor-hint"><GripVertical size={14}/><span>拖动手柄调整顺序</span></p>
      {dragging && <div className="order-drop-slot" aria-hidden="true"/>}
      {draft.map((item, index) => <div className="order-row" key={item.id} data-order-row={item.id} data-dragging={dragging === item.id}>
        <span className="order-position">{index + 1}</span>
        <Artwork className="order-artwork" src={item.coverUrl} fallback={item.kind === 'folder' || item.group === 'folders' ? <Folder size={19}/> : item.kind === 'linked' ? <Link2 size={19}/> : <ListMusic size={19}/>}/>
        <strong title={item.name}>{item.name}</strong>
        <span className="order-step-actions">
          <button type="button" disabled={busy || index === 0 || draft[index - 1]?.group !== item.group} title="上移" aria-label={`上移${item.name}`} onClick={() => move(item.id, draft[index - 1].id)}><ArrowUp size={15}/></button>
          <button type="button" disabled={busy || index === draft.length - 1 || draft[index + 1]?.group !== item.group} title="下移" aria-label={`下移${item.name}`} onClick={() => move(item.id, draft[index + 1].id)}><ArrowDown size={15}/></button>
        </span>
        <button type="button" className="order-drag-handle" disabled={busy} aria-label={`拖动${item.name}，也可用上下方向键`} onPointerDown={event => {
          event.preventDefault(); event.stopPropagation()
          const row = event.currentTarget.closest<HTMLElement>('[data-order-row]')!
          drag.current = { id: item.id, pointer: event.pointerId, offset: event.clientY - row.getBoundingClientRect().top, y: event.clientY }
          setDragging(item.id); editor.current?.setPointerCapture(event.pointerId)
        }} onKeyDown={event => {
          const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : -1
          if (to >= 0 && to < draft.length) { event.preventDefault(); move(item.id, draft[to].id) }
        }}><GripVertical size={19}/></button>
      </div>)}
    </div>}</>,
  }
}
