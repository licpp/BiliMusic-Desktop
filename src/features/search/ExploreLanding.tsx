import { type Ref } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, TvMinimalPlay } from 'lucide-react'
import { recommendationDay, recommendationDayLabel } from '../../domain/recommendation'
import { hotSearchQuery, type HotSearchBadge } from '../../services/hotSearch'
import { inDesktopShell } from '../../services/desktopApi'
import './explore.css'

const badgeLabels: Record<HotSearchBadge, { text: string; label: string }> = {
  hot: { text: '热', label: '热搜' },
  new: { text: '新', label: '新上榜' },
}

type Props = {
  active?: boolean
  history: string[]
  onSearch: (keyword: string) => void
  onOpenRecommendation: () => void
  onOpenBiliFeed: () => void
  recommendationRef?: Ref<HTMLButtonElement>
  biliFeedRef?: Ref<HTMLButtonElement>
}

export function ExploreLanding({ active = true, history, onSearch, onOpenRecommendation, onOpenBiliFeed, recommendationRef, biliFeedRef }: Props) {
  const { day, month } = recommendationDayLabel(recommendationDay(new Date()))
  return <section className="explore-landing" hidden={!active} aria-label="探索首页">
    {history.length > 0 && <div className="explore-history">
      <strong>最近搜索</strong>
      <div>{history.slice(0, 5).map(word =>
        <button type="button" key={word} title={word} onClick={() => onSearch(word)}>{word}</button>)}</div>
    </div>}
    <div className="explore-recommendations">
      <button ref={recommendationRef} type="button" className="explore-card explore-daily" data-focus="explore-daily"
        onClick={onOpenRecommendation} aria-label="每日推荐">
        <span className="explore-card-mark explore-date" aria-hidden="true"><strong>{day}</strong><small>{month}月</small></span>
        <span className="explore-card-copy"><strong>每日推荐</strong><small>网易云音乐</small></span>
        <ChevronRight size={19} aria-hidden="true"/>
      </button>
      <button ref={biliFeedRef} type="button" className="explore-card explore-bili-feed" data-focus="explore-bili-feed"
        onClick={onOpenBiliFeed} aria-label="B 站推荐">
        <span className="explore-card-mark" aria-hidden="true"><TvMinimalPlay size={27}/></span>
        <span className="explore-card-copy"><strong>B 站推荐</strong><small>个性化视频</small></span>
        <ChevronRight size={19} aria-hidden="true"/>
      </button>
    </div>
    {inDesktopShell && <HotSearchBoard active={active} onSearch={onSearch}/>}
  </section>
}

function HotSearchBoard({ active, onSearch }: { active: boolean; onSearch: Props['onSearch'] }) {
  const chart = useQuery({ ...hotSearchQuery(), enabled: active })
  const items = chart.data?.items ?? []
  return <section className="explore-hot" aria-labelledby="bilibili-hot-search-title">
    <header className="explore-hot-heading"><h2 id="bilibili-hot-search-title">B 站热搜</h2></header>
    {items.length > 0 ? <>
      {chart.data?.stale && <p className="explore-hot-status">正在显示上次更新的热搜</p>}
      <ol className="explore-ranks">
        {items.map(({ keyword, title = keyword, badge }, index) => {
          const label = badge && badgeLabels[badge]
          return <li key={keyword}>
            <button type="button" title={title} aria-label={label ? `${title}，${label.label}` : undefined}
              data-focus={`explore-bilibili-${index + 1}`} onClick={() => onSearch(keyword)}>
              <span className="explore-rank" aria-hidden="true">{index + 1}</span>
              <span className="explore-rank-copy">
                <span className="explore-word">{title}</span>
                {label && <span className="explore-hot-badge" data-badge={badge} aria-hidden="true">{label.text}</span>}
              </span>
            </button>
          </li>
        })}
      </ol>
    </> : <div className="explore-hot-message">
      {chart.isPending || chart.isFetching
        ? <p className="explore-hot-status" role="status">正在读取热搜…</p>
        : <><p className="explore-hot-status" role="status">暂时无法获取热搜</p>
          <button type="button" className="explore-hot-action" onClick={() => void chart.refetch()}>重试</button></>}
    </div>}
  </section>
}
