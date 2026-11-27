import { Play, UserRound } from 'lucide-react'
import type { MouseEventHandler, ReactNode, Ref } from 'react'
import type { BiliVideoAccess } from '../domain/bilibili'
import { Artwork } from './Artwork'
import { CoverCount } from './CoverCount'
import { PlayingMark } from './PlayingMark'
import { PublishedDate } from './PublishedDate'
import { VideoAccessBadge } from './VideoAccessBadge'
import { formatPlayCount } from './count'
import { formatDuration } from './time'

export function VideoResultRow({ title, ariaLabel, focusId, coverUrl, coverRef, count, countUnit, durationSeconds, uploaderName, playCount, publishedAt, access, currentId, disabled, onClick, onContextMenu, actions }: {
  title: string
  ariaLabel?: string
  focusId?: string
  coverUrl?: string
  coverRef?: Ref<HTMLSpanElement>
  count?: number
  countUnit?: '个视频'
  durationSeconds?: number
  uploaderName?: string
  playCount?: number
  publishedAt?: number
  access?: BiliVideoAccess
  currentId?: string
  disabled?: boolean
  onClick: () => void
  onContextMenu?: MouseEventHandler<HTMLButtonElement>
  actions?: ReactNode
}) {
  const showStats = playCount !== undefined || Boolean(publishedAt)
  return <div className="video-result-row playing-row" data-current-row={currentId}>
    <button type="button" className="video-result-play" aria-label={ariaLabel} aria-current={currentId ? 'true' : undefined} data-focus={focusId}
      disabled={disabled} onContextMenu={onContextMenu} onClick={onClick}>
      <span className="video-result-cover">
        <Artwork variant="thumbnail" src={coverUrl} elementRef={coverRef}/>
        {durationSeconds !== undefined && durationSeconds > 0 && <span className="video-result-duration">{formatDuration(durationSeconds)}</span>}
        <span className="video-result-play-icon" aria-hidden="true"><Play size={17} fill="currentColor"/></span>
        {currentId && <PlayingMark/>}<CoverCount count={count} unit={countUnit} single={Boolean(countUnit)}/><VideoAccessBadge access={access} onCover/>
      </span>
      <span className="video-result-copy">
        <strong title={title}>{title}</strong>
        {(uploaderName || showStats) && <span className="video-result-meta">
          {uploaderName && <span className="video-result-uploader" title={uploaderName}><UserRound size={13} aria-hidden="true"/><span>{uploaderName}</span></span>}
          {showStats && <span className="video-result-stats">
            {playCount !== undefined && <span aria-label={`${formatPlayCount(playCount)} 次播放`}><Play size={12} aria-hidden="true"/>{formatPlayCount(playCount)}</span>}
            <PublishedDate value={publishedAt}/>
          </span>}
        </span>}
      </span>
    </button>
    {actions && <div className="video-result-actions">{actions}</div>}
  </div>
}
