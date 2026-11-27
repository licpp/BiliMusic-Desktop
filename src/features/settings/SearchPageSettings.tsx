import { Search } from 'lucide-react'
import { useSearchPagePreference } from '../../services/searchPagePreference'

export function SearchPageSettings() {
  const simple = useSearchPagePreference(state => state.simple)
  const toggle = useSearchPagePreference(state => state.toggle)
  return <section className="settings-card">
    <div className="settings-icon"><Search/></div>
    <div><strong id="simple-search-page-label">简洁搜索页</strong><small>关闭后显示推荐与热搜</small></div>
    <button className="auto-resume-switch" type="button" role="switch" aria-labelledby="simple-search-page-label"
      aria-checked={simple} onClick={toggle}><span aria-hidden="true"/></button>
  </section>
}
