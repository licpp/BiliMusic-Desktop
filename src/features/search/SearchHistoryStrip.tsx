import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Clock3 } from 'lucide-react'
import { CollectionDialog } from '../../shared/CollectionDialog'
import './search-history.css'

export function SearchHistoryStrip({ history, onSearch, onClear, clearing }: {
  history: string[]
  onSearch: (keyword: string) => void
  onClear: () => void
  clearing: boolean
}) {
  const [open, setOpen] = useState(false)
  const pendingSearch = useRef<string | undefined>(undefined)
  useEffect(() => {
    // Let the dialog release its focus lock before the next page takes focus.
    if (open || pendingSearch.current === undefined) return
    const keyword = pendingSearch.current
    pendingSearch.current = undefined
    onSearch(keyword)
  }, [open, onSearch])
  if (!history.length && !open) return null

  return <>
    {history.length > 0 && <div className="search-history-strip" role="group" aria-label="最近搜索">
      <button type="button" className="search-history-open" aria-label="查看最近搜索"
        aria-haspopup="dialog" aria-expanded={open} data-focus="search-history"
        onClick={() => setOpen(true)}>
        最近搜索<ChevronRight size={14} aria-hidden="true"/>
      </button>
      <div className="search-history-shortcuts">
        {history.slice(0, 4).map(word =>
          <button type="button" key={word} title={word} onClick={() => onSearch(word)}>{word}</button>
        )}
      </div>
    </div>}
    {open && <CollectionDialog title="最近搜索" onClose={() => setOpen(false)} className="search-history-dialog" mobileSheet>
      {history.length > 0 ? <>
        <ul className="search-history-items">
          {history.map(word => <li key={word}>
            <button type="button" onClick={() => { pendingSearch.current = word; setOpen(false) }}>
              <Clock3 size={16} aria-hidden="true"/><span>{word}</span>
            </button>
          </li>)}
        </ul>
        <div className="search-history-actions">
          <button type="button" className="collection-flat-button" onClick={onClear} disabled={clearing}>清空记录</button>
        </div>
      </> : <p className="search-history-empty" role="status">暂无搜索记录</p>}
    </CollectionDialog>}
  </>
}
