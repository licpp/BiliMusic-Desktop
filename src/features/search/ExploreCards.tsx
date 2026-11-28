import type { Ref } from 'react'
import { ChevronRight, TvMinimalPlay } from 'lucide-react'
import { recommendationDay, recommendationDayLabel } from '../../domain/recommendation'

/**
 * The search page renders these cards as entries. The settings preview reuses
 * the same markup; it renders the card as an inert span inside its own link, so
 * a preview never becomes a second entry in the focus order.
 */
type ExploreCardProps = {
  onOpen?: () => void
  cardRef?: Ref<HTMLButtonElement>
  interactive?: boolean
}

export function DailyRecommendationCard({ onOpen, cardRef, interactive = true }: ExploreCardProps) {
  const { day, month } = recommendationDayLabel(recommendationDay(new Date()))
  const content = <>
    <span className="explore-card-mark explore-date" aria-hidden="true"><strong>{day}</strong><small>{month}月</small></span>
    <span className="explore-card-copy"><strong>每日推荐</strong><small>网易云音乐</small></span>
    <ChevronRight size={19} aria-hidden="true"/>
  </>
  return interactive
    ? <button ref={cardRef} type="button" className="explore-card explore-daily"
      data-focus={onOpen ? 'explore-daily' : undefined} onClick={onOpen} tabIndex={onOpen ? undefined : -1}
      aria-label="每日推荐">{content}</button>
    : <span className="explore-card explore-daily">{content}</span>
}

export function BiliFeedCard({ onOpen, cardRef }: ExploreCardProps) {
  return <button ref={cardRef} type="button" className="explore-card explore-bili-feed"
    data-focus={onOpen ? 'explore-bili-feed' : undefined} onClick={onOpen} tabIndex={onOpen ? undefined : -1}
    aria-label="B 站推荐">
    <span className="explore-card-mark" aria-hidden="true"><TvMinimalPlay size={27}/></span>
    <span className="explore-card-copy"><strong>B 站推荐</strong><small>个性化视频</small></span>
    <ChevronRight size={19} aria-hidden="true"/>
  </button>
}
