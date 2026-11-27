import { useEffect, useId, useState, type Ref } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, TvMinimalPlay } from 'lucide-react'
import { recommendationDay, recommendationDayLabel } from '../../domain/recommendation'
import { hotSearchQuery, type HotSearchBadge } from '../../services/hotSearch'
import { inDesktopShell } from '../../services/desktopApi'
import { EXTENSIONS, useSearchExtensions } from '../../services/extensions'
import { isLargeScreen } from '../../services/platform'
import { useTabletWidth } from '../../shared/useCompactLayout'
import './explore.css'

const hotSearchExtensions = EXTENSIONS.filter(extension => extension.group === 'hot-search')
type HotSearchExtension = (typeof hotSearchExtensions)[number]

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
  const enabled = useSearchExtensions()
  const showDaily = enabled.includes('daily')
  const showBiliFeed = enabled.includes('feed')
  const hotSources = hotSearchExtensions.filter(extension => enabled.includes(extension.id))
  const { day, month } = recommendationDayLabel(recommendationDay(new Date()))
  return <section className="explore-landing" hidden={!active} aria-label="搜索首页">
    {history.length > 0 && <div className="explore-history">
      <strong>最近搜索</strong>
      <div>{history.slice(0, 5).map(word =>
        <button type="button" key={word} title={word} onClick={() => onSearch(word)}>{word}</button>)}</div>
    </div>}
    {(showDaily || showBiliFeed) && <div className="explore-recommendations">
      {showDaily && <button ref={recommendationRef} type="button" className="explore-card explore-daily" data-focus="explore-daily"
        onClick={onOpenRecommendation} aria-label="每日推荐">
        <span className="explore-card-mark explore-date" aria-hidden="true"><strong>{day}</strong><small>{month}月</small></span>
        <span className="explore-card-copy"><strong>每日推荐</strong><small>网易云音乐</small></span>
        <ChevronRight size={19} aria-hidden="true"/>
      </button>}
      {showBiliFeed && <button ref={biliFeedRef} type="button" className="explore-card explore-bili-feed" data-focus="explore-bili-feed"
        onClick={onOpenBiliFeed} aria-label="B 站推荐">
        <span className="explore-card-mark" aria-hidden="true"><TvMinimalPlay size={27}/></span>
        <span className="explore-card-copy"><strong>B 站推荐</strong><small>个性化视频</small></span>
        <ChevronRight size={19} aria-hidden="true"/>
      </button>}
    </div>}
    {inDesktopShell && hotSources.length > 0 && <HotSearchGroup active={active} sources={hotSources} onSearch={onSearch}/>}
  </section>
}

function HotSearchGroup({ active, sources, onSearch }: {
  active: boolean
  sources: HotSearchExtension[]
  onSearch: Props['onSearch']
}) {
  const tabletWidth = useTabletWidth()
  const singleColumn = !isLargeScreen && !tabletWidth
  const [choice, setChoice] = useState(() => sources[0].id)
  const selected = sources.find(source => source.id === choice) ?? sources[0]
  useEffect(() => {
    setChoice(selected.id)
  }, [selected.id])
  const boards = singleColumn ? [selected] : sources
  return <section className="explore-hot" aria-label="热搜" data-single-column={singleColumn}>
    {singleColumn && sources.length > 1 && <div className="explore-hot-sources" role="group" aria-label="热搜来源">
      {sources.map(source => <button key={source.id} type="button" aria-pressed={selected.id === source.id}
        onClick={() => setChoice(source.id)}>{source.source === 'bilibili' ? 'B 站' : source.title.replace(/热搜$/, '')}</button>)}
    </div>}
    <div className="explore-hot-charts">
      {boards.map(source => <HotSearchBoard key={source.id} active={active} extension={source} onSearch={onSearch}/>)}
    </div>
  </section>
}

function HotSearchBoard({ active, extension, onSearch }: {
  active: boolean
  extension: HotSearchExtension
  onSearch: Props['onSearch']
}) {
  const { source, title: heading } = extension
  const id = useId()
  const chart = useQuery({ ...hotSearchQuery(source), enabled: active })
  const [expanded, setExpanded] = useState(false)
  const items = chart.data?.items ?? []
  const bili = source === 'bilibili'
  const visible = bili || expanded ? items : items.slice(0, initialRanks)
  return <section className="explore-hot-board" data-source={source} aria-labelledby={id}>
    <h2 id={id}>{heading}</h2>
    {items.length > 0 ? <>
      {chart.data?.stale && <p className="explore-hot-status">正在显示上次更新的热搜</p>}
      <ol id={`${id}-ranks`} className="explore-ranks">
        {visible.map(({ keyword, title = keyword, badge }, index) => {
          const label = badge && badgeLabels[badge]
          return <li key={keyword}>
            <button type="button" title={title} aria-label={label ? `${title}，${label.label}` : undefined}
              data-focus={`explore-${source}-${index + 1}`} onClick={() => onSearch(keyword)}>
              <span className="explore-rank" aria-hidden="true">{index + 1}</span>
              <span className="explore-rank-copy">
                <span className="explore-word">{title}</span>
                {label && <span className="explore-hot-badge" data-badge={badge} aria-hidden="true">{label.text}</span>}
              </span>
            </button>
          </li>
        })}
      </ol>
      {!bili && items.length > initialRanks && <button type="button" className="explore-hot-action"
        data-focus={`explore-${source}-more`} aria-controls={`${id}-ranks`} aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>{expanded ? '收起热搜' : '更多热搜'}</button>}
    </> : <div className="explore-hot-message">
      {chart.isPending || chart.isFetching
        ? <p className="explore-hot-status" role="status">正在读取热搜…</p>
        : <><p className="explore-hot-status" role="status">暂时无法获取热搜</p>
          <button type="button" className="explore-hot-action" data-focus={`explore-${source}-retry`}
            onClick={() => void chart.refetch()}>重试</button></>}
    </div>}
  </section>
}
