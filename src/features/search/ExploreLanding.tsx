import { useId, useState, type Ref } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Search, TvMinimalPlay } from 'lucide-react'
import { recommendationDay, recommendationDayLabel } from '../../domain/recommendation'
import { hotSearchQuery, type HotSearchBadge, type HotSearchSource } from '../../services/hotSearch'
import { inDesktopShell } from '../../services/desktopApi'
import './explore.css'

const musicSources = [
  { id: 'netease', label: '网易云音乐' },
  { id: 'qq', label: 'QQ 音乐' },
] as const
const biliSource = { id: 'bilibili', label: 'B 站' } as const
const sources = [biliSource, ...musicSources] as const
const initialRanks = 5
const badgeLabels: Record<HotSearchBadge, { text: string; label: string }> = {
  hot: { text: '热', label: '热搜' },
  new: { text: '新', label: '新上榜' },
  viral: { text: '爆', label: '爆' },
  rising: { text: '↑', label: '热度上升' },
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
  const [source, setSource] = useState<HotSearchSource>('bilibili')
  const { day, month } = recommendationDayLabel(recommendationDay(new Date()))
  const pickerId = useId()
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
    {inDesktopShell && <section className="explore-hot" aria-label="热门搜索">
      <header className="explore-hot-heading explore-hot-mobile-heading">
        <h2>热门搜索</h2>
        <div className="explore-hot-sources" role="group" aria-label="热搜来源">
          {sources.map(item => <button key={item.id} type="button" aria-pressed={source === item.id}
            aria-controls={`${pickerId}-${item.id}`} onClick={() => setSource(item.id)}>{item.label}</button>)}
        </div>
      </header>
      <HotSearchBoard id={`${pickerId}-bilibili`} active={active} source={biliSource}
        selected={source === 'bilibili'} onSearch={onSearch}/>
      <div className="explore-music-hot">
        <header className="explore-hot-heading"><h2>音乐热搜</h2></header>
        <div className="explore-hot-charts">
          {musicSources.map(item => <HotSearchBoard key={item.id} id={`${pickerId}-${item.id}`} active={active}
            source={item} selected={source === item.id} onSearch={onSearch}/>)}
        </div>
      </div>
    </section>}
  </section>
}

function HotSearchBoard({ id, active, source, selected, onSearch }: {
  id: string
  active: boolean
  source: { id: HotSearchSource; label: string }
  selected: boolean
  onSearch: Props['onSearch']
}) {
  const chart = useQuery({ ...hotSearchQuery(source.id), enabled: active })
  const [expanded, setExpanded] = useState(false)
  const items = chart.data?.items ?? []
  const isBilibili = source.id === 'bilibili'
  const visibleItems = isBilibili || expanded ? items : items.slice(0, initialRanks)
  return <section id={id} className="explore-hot-board" data-source={source.id} data-selected={selected}
    aria-label={`${source.label}热搜`}>
    {isBilibili ? <header className="explore-hot-heading"><h2>B 站热搜</h2></header> : <h3>{source.label}</h3>}
    {items.length > 0 ? <>
      {chart.data?.stale && <p className="explore-hot-status">正在显示上次更新的热搜</p>}
      <ol id={`${id}-ranks`} className="explore-ranks">
        {visibleItems.map(({ keyword, title = keyword, badge }, index) => {
          const label = badge && badgeLabels[badge]
          return <li key={keyword}>
            <button type="button" title={title} aria-label={label ? `${title}，${label.label}` : undefined}
              data-focus={`explore-${source.id}-${index + 1}`} onClick={() => onSearch(keyword)}>
              <span className="explore-rank" aria-hidden="true">{index + 1}</span>
              <span className="explore-rank-copy">
                <span className="explore-word">{title}</span>
                {label && <span className="explore-hot-badge" data-badge={badge} aria-hidden="true">{label.text}</span>}
              </span>
              {!isBilibili && <Search size={14} aria-hidden="true"/>}
            </button>
          </li>
        })}
      </ol>
      {!isBilibili && items.length > initialRanks && <button type="button" className="explore-hot-action"
        data-focus={`explore-${source.id}-more`} aria-controls={`${id}-ranks`} aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>{expanded ? '收起热搜' : '更多热搜'}</button>}
    </> : <div className="explore-hot-message">
      {chart.isPending || chart.isFetching
        ? <p className="explore-hot-status" role="status">正在读取热搜…</p>
        : <><p className="explore-hot-status" role="status">暂时无法获取热搜</p>
          <button type="button" className="explore-hot-action" onClick={() => void chart.refetch()}>重试</button></>}
    </div>}
  </section>
}
