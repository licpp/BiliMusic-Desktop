import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { Track } from '../domain/track'

export function matchesListSearch(query: string, ...values: (string | undefined)[]) {
  const haystack = values.filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase()
  return query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).every(term => haystack.includes(term))
}
export function matchesTrackSearch(track: Track, query: string) {
  return matchesListSearch(query, track.title, track.artist, track.album, track.source.uploaderName, track.source.bvid)
}
export function ListSearch({ query, onChange, count, label = '搜索列表中的音乐' }: { query: string; onChange: (value: string) => void; count: number; label?: string }) {
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const previous = useRef('')
  const origin = useRef<{element:HTMLElement;top:number} | undefined>(undefined)
  useLayoutEffect(() => {
    let element = holder.current?.parentElement
    while (element && !/(auto|scroll)/.test(getComputedStyle(element).overflowY)) element=element.parentElement
    if (!previous.current.trim() && query.trim() && element) {
      origin.current={element,top:element.scrollTop};element.scrollTop=0
    } else if (previous.current.trim() && !query.trim() && origin.current) {
      origin.current.element.scrollTop=origin.current.top;origin.current=undefined
    }
    previous.current=query
  },[query])
  useEffect(() => {
    const shortcut = (event: Event) => {
      if (!holder.current?.getClientRects().length || document.querySelector('[aria-modal="true"]')) return
      event.preventDefault(); setOpen(true); requestAnimationFrame(() => input.current?.focus())
    }
    window.addEventListener('bilimusic-list-search', shortcut)
    return () => window.removeEventListener('bilimusic-list-search', shortcut)
  }, [])
  return <div ref={holder} className={`list-search${open ? ' open' : ''}`}>
    {open ? <label className="search-field list-search-field"><Search size={16} aria-hidden="true"/><input ref={input} type="search" role="searchbox" autoComplete="off" autoFocus aria-label={label} placeholder={label} value={query} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onChange(''); setOpen(false) } }}/><button type="button" aria-label="关闭列表搜索" onClick={() => { onChange(''); setOpen(false) }}><X size={16}/></button></label> : <button type="button" className="collection-icon" title={label} aria-label={label} onClick={() => setOpen(true)}><Search size={18}/></button>}
    {query.trim() && <small role="status">{count} 个结果</small>}
  </div>
}
