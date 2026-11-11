import { Artwork } from '../../shared/Artwork'
import { formatAudienceCount } from '../../shared/count'
import { isMobile } from '../../services/platform'
import { useMemo, useRef, type ReactNode } from 'react'
import { ListChecks, Play } from 'lucide-react'
import type { Track } from '../../domain/track'
import { formatDuration } from '../../shared/time'
import { PlayingMark } from '../../shared/PlayingMark'
import { useLocateCurrentRow } from '../../shared/useLocateCurrentRow'
import { useVisibleVideoPages } from '../../shared/useVisibleVideoPages'
import { usePlayerStore, type QueueSource } from '../player/playerStore'
import { TrackMenuButton } from './TrackActions'
import { showTrackMenu } from './trackActionStore'
import { BatchTrackActions, useTrackSelection } from './useTrackSelection'

export function VideoPartsList({ tracks, visibleTracks = tracks, renderActions, videoCollection = false, locateCurrent = false, onOpenParts, playbackTracks = tracks, queueSource, totalCount }: {
  totalCount?: number
  videoCollection?: boolean
  locateCurrent?: boolean
  onOpenParts?: (track: Track) => void
  queueSource?: QueueSource
  playbackTracks?: Track[]
  tracks: Track[]
  visibleTracks?: Track[]
  renderActions?: (track: Track) => ReactNode
}) {
  const currentId = usePlayerStore(state => state.current?.id)
  const currentBvid = usePlayerStore(state => state.current?.source.bvid)
  const root = useRef<HTMLDivElement>(null)
  const activeTrack = visibleTracks.find(track => track.id === currentId)
    ?? (videoCollection ? visibleTracks.find(track => track.source.bvid === currentBvid) : undefined)
  useLocateCurrentRow(root, locateCurrent, activeTrack?.id)
  const byId = useMemo(() => new Map(playbackTracks.map(track => [track.id, track])), [playbackTracks])
  const selection = useTrackSelection(videoCollection ? visibleTracks.map(track => byId.get(track.id) ?? track) : visibleTracks)
  if (!visibleTracks.length) return null
  return <div className="parts-list video-parts-list" ref={root}>
    {selection.selecting ? <BatchTrackActions selection={selection} total={visibleTracks.length} /> :
      <div className="video-parts-toolbar">
        <span>{totalCount ?? visibleTracks.length} {videoCollection || (tracks.length === 1 && tracks[0].partCount === 1) ? '个视频' : '个分 P'}</span>
        <button type="button" className="collection-flat-button" onClick={selection.enter}><ListChecks size={16}/>多选</button>
      </div>}
    {visibleTracks.map((track, index) => <VideoPartsRow key={track.id} track={track} index={index}
      active={track.id === activeTrack?.id} videoCollection={videoCollection} selecting={selection.selecting}
      checked={selection.ids.has(track.id)} onSelect={() => selection.toggle(track.id)}
      actionTrack={byId.get(track.id) ?? track} playbackTracks={playbackTracks} queueSource={queueSource} onOpenParts={onOpenParts} renderActions={renderActions}/>)}
  </div>
}

function VideoPartsRow({ track, index, active, videoCollection, selecting, checked, onSelect, actionTrack, playbackTracks, queueSource, onOpenParts, renderActions }: {
  track: Track; index: number; active: boolean; videoCollection: boolean; selecting: boolean; checked: boolean
  onSelect: () => void; actionTrack: Track; playbackTracks: Track[]; queueSource?: QueueSource
  onOpenParts?: (track: Track) => void; renderActions?: (track: Track) => ReactNode
}) {
  const { ref, pages } = useVisibleVideoPages(track.source.bvid, videoCollection && track.partCount === undefined)
  const count = track.partCount ?? pages?.length
  const openParts = onOpenParts && (count ?? 0) > 1 ? () => onOpenParts(track) : undefined
  const play = () => void usePlayerStore.getState().playFromList(playbackTracks, track.id, queueSource)
  const actions = { openParts, play }
  const duration = track.durationSeconds || (count === 1 ? pages?.[0]?.durationSeconds : undefined)
  const label = videoCollection ? index + 1 : track.partCount === 1 ? '视频' : `P${track.source.page}`
  return <div ref={ref} data-current-row={active ? track.id : undefined} className={`part-entry video-part-row${videoCollection ? ' video-with-cover' : ''}${selecting ? '' : ' playing-row'}`}
    onContextMenu={event => {
      event.preventDefault()
      event.stopPropagation()
      if (selecting) return
      if (isMobile && openParts) openParts()
      else showTrackMenu(event, actionTrack, undefined, playbackTracks, actions)
    }}>
    {selecting ? <label className="video-part-select">
      <input className="track-select" type="checkbox" aria-label={`选择 ${track.title}`} checked={checked} onChange={onSelect}/>
      <span>{label}</span><strong>{track.title}</strong><small>{formatDuration(track.durationSeconds)}</small>
    </label> : <>
      <button type="button" className="video-part-play" aria-current={active ? 'true' : undefined} aria-label={`播放 ${track.title}`} onClick={play}>
        <span className="video-part-index">{videoCollection ? <Artwork src={track.coverUrl}/> : active ? <PlayingMark/> : label}</span><span className="video-part-copy"><strong>{track.title}{openParts && <small className="video-part-count">{count} P</small>}</strong><span className="video-part-meta">{videoCollection && track.playCount !== undefined && <small className="video-part-views">{formatAudienceCount(track.playCount)} 次播放</small>}<small className="video-part-inline-duration">{duration ? formatDuration(duration) : '—'}</small></span></span><small className="video-part-duration">{duration ? formatDuration(duration) : '—'}</small><Play size={14}/>
      </button>
      {!isMobile && renderActions?.(track)}
      <TrackMenuButton track={actionTrack} tracks={playbackTracks} actions={actions}/>
    </>}
  </div>
}
