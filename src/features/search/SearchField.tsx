import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock3, Search, X } from 'lucide-react'
import { getSearchSuggestions } from '../../services/desktopApi'

type Props = {
  value: string; focused: boolean; history: string[]
  onChange: (value: string) => void; onFocus: () => void; onBlur: () => void
  onSearch: (value: string) => void; onClear: () => void; onClearHistory: () => void
}
export function SearchField(props: Props) {
  const [debounced, setDebounced] = useState('')
  const [composing, setComposing] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keyword = props.value.trim()
  useEffect(() => {
    setActive(-1)
    const timer = window.setTimeout(() => setDebounced(keyword), 300)
    return () => window.clearTimeout(timer)
  }, [keyword])
  useEffect(() => () => clearTimeout(blurTimer.current), [])
  const suggestions = useQuery({
    queryKey: ['search-suggestions', debounced], queryFn: () => getSearchSuggestions(debounced),
    enabled: props.focused && !composing && !dismissed && !!debounced && debounced === keyword,
    staleTime: 60_000, gcTime: 120_000, retry: false,
  })
  const isHistory = !keyword
  const options = isHistory ? props.history : debounced === keyword ? suggestions.data || [] : []
  const visible = props.focused && !composing && !dismissed && options.length > 0
  useEffect(() => {
    if (visible && active >= 0) document.getElementById(`search-suggestion-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [visible, active])
  const choose = (value: string) => {
    setDismissed(true); setActive(-1); props.onSearch(value); input.current?.blur()
  }
  return <div className="search-field">
    <Search size={17} />
    <input ref={input} value={props.value} role="combobox" aria-label="搜索歌曲、歌手或专辑" aria-autocomplete="list" aria-expanded={visible} aria-controls="search-suggestions" aria-activedescendant={visible && active >= 0 ? `search-suggestion-${active}` : undefined} autoComplete="off"
      onFocus={() => { clearTimeout(blurTimer.current); setDismissed(false); props.onFocus() }}
      onBlur={() => { blurTimer.current = setTimeout(props.onBlur, 120) }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onChange={event => { setDismissed(false); if (!props.focused) props.onFocus(); props.onChange(event.target.value) }}
      onKeyDown={event => {
        if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Escape') { setDismissed(true); setActive(-1); return }
        if (!visible) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setActive(index => event.key === 'ArrowDown' ? (index + 1) % options.length : (index <= 0 ? options.length : index) - 1)
        } else if (event.key === 'Enter' && active >= 0 && options[active]) {
          event.preventDefault(); choose(options[active])
        }
      }} placeholder="搜索歌曲、歌手或专辑" />
    {props.value && <button type="button" className="icon-action search-reset" aria-label="清空搜索并返回搜索首页" onClick={props.onClear}><X size={16}/></button>}
    {visible && <div className="search-history-popover search-suggestions" id="search-suggestions" role="listbox" aria-label={isHistory ? '搜索历史' : 'B站搜索建议'}>
      <header><span>{isHistory ? '最近搜索' : '搜索建议'}</span>{isHistory && <button type="button" onMouseDown={event => event.preventDefault()} onClick={props.onClearHistory}>清除</button>}</header>
      {options.map((word, index) => <button type="button" key={word} id={`search-suggestion-${index}`} role="option" aria-selected={index === active} onMouseDown={event => event.preventDefault()} onClick={() => choose(word)}>{isHistory ? <Clock3 size={14}/> : <Search size={14}/>}<span>{word}</span></button>)}
    </div>}
  </div>
}
