import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { focusSearch } from './focusSearch'
import type { Track } from '../domain/track'

export function matchesListSearch(query: string, ...values: (string | undefined)[]) {
  const haystack = values.filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase()
  return query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).every(term => haystack.includes(term))
}
export function matchesTrackSearch(track: Track, query: string) {
  return matchesListSearch(query, track.title, track.videoTitle, track.sourceTitleContext?.season?.title, track.artist, track.album, track.source.uploaderName, track.source.bvid)
}
export function ListSearch({ query, onChange, count, label = '搜索列表中的音乐', disabled }: { disabled?: boolean; query: string; onChange: (value: string) => void; count: number; label?: string }) {
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => {
    setOpen(false); onChange('')
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
  }
  const previous = useRef('')
  const origin = useRef<{ element: HTMLElement; top: number } | undefined>(undefined)
  const change = (value: string) => {
    if (!query.trim() && value.trim()) {
      let element = holder.current?.parentElement
      while (element && !/(auto|scroll)/.test(getComputedStyle(element).overflowY)) element = element.parentElement
      if (element) origin.current = { element, top: element.scrollTop }
    }
    onChange(value)
  }
  useLayoutEffect(() => {
    if (!previous.current.trim() && query.trim() && origin.current) {
      origin.current.element.scrollTop = 0
    } else if (previous.current.trim() && !query.trim() && origin.current) {
      origin.current.element.scrollTop = origin.current.top
      origin.current = undefined
    }
    previous.current = query
  }, [query])
  useEffect(() => {
    const shortcut = (event: Event) => {
      if (disabled || !holder.current?.getClientRects().length || holder.current.closest('[inert],[hidden]') || document.querySelector('[aria-modal="true"]')) return
      event.preventDefault(); focusSearch(() => setOpen(true), input)
    }
    window.addEventListener('bilimusic-list-search', shortcut)
    return () => window.removeEventListener('bilimusic-list-search', shortcut)
  }, [disabled])
  return <div ref={holder} className={`list-search${open ? ' open' : ''}`}>
    {open ? <label className="search-field list-search-field"><Search size={16} aria-hidden="true"/><input ref={input} type="search" role="searchbox" disabled={disabled} autoComplete="off" aria-label={label} placeholder={label} value={query} onChange={event => change(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}/><button type="button" aria-label="关闭列表搜索" disabled={disabled} onClick={close}><X size={16}/></button></label> : <button ref={trigger} type="button" disabled={disabled} className="collection-icon" title={label} aria-label={label} onClick={() => focusSearch(() => setOpen(true), input)}><Search size={18}/></button>}
    {query.trim() && <small role="status">{count} 个结果</small>}
  </div>
}
