import { ChevronRight, Search } from 'lucide-react'

const keywords = ['音乐现场', '纯音乐 合集', '游戏原声', '有声书', '爵士', '钢琴']

export function SimpleSearchLanding({ onSearch }: { onSearch: (keyword: string) => void }) {
  return <section className="discover-view search-landing">
    <h2>寻找下一首歌</h2>
    <div className="quick-actions">{keywords.map(keyword =>
      <button type="button" key={keyword} onClick={() => onSearch(keyword)}><Search/><strong>{keyword}</strong><ChevronRight/></button>,
    )}</div>
  </section>
}
