import { useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

export function ScopedSearchField({ value, onChange, creator = false, className = '' }: {
  value: string; onChange: (value: string) => void; creator?: boolean; className?: string
}) {
  const composing = useRef(false)
  const [draft, setDraft] = useState<string>()
  const label = creator ? '搜索当前 UP 主的投稿' : '搜索当前合集'
  return <label className={`scoped-search-field ${className}`}>
    <Search size={18} aria-hidden="true" />
    <input type="text" role="searchbox" enterKeyHint="search" aria-label={label} placeholder={creator ? '搜索这位 UP 主的投稿' : '搜索此合集中的内容'} value={draft ?? value} maxLength={200} autoComplete="off"
      onCompositionStart={() => { composing.current = true; setDraft(value) }}
      onCompositionEnd={event => { composing.current = false; setDraft(undefined); onChange(event.currentTarget.value) }}
      onChange={event => { if (composing.current) setDraft(event.target.value); else onChange(event.target.value) }}
      onKeyDown={event => { if (event.key === 'Enter' && !composing.current && !event.nativeEvent.isComposing) event.currentTarget.blur() }} />
    {value && <button type="button" aria-label="清空当前内容搜索" onClick={() => onChange('')}><X size={16} /></button>}
  </label>
}
