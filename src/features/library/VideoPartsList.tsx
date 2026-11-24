import { useListRows } from '../../shared/useListRows'
import { useListReveal } from '../../shared/useListMotion'
import { offlineUnavailable, useOfflinePlayback } from '../player/offlinePlayback'
import { projectSeasonRows, trackHidden, videoScope, visibilityChange } from '../../domain/contentVisibility'
import { saveVisibility, useVisibilityRules } from '../../services/contentVisibility'
import { VisibilityControls } from '../../shared/VisibilityControls'
import { useManagedVisibilityScope } from '../../shared/useManagedVisibilityScope'
import { CoverCount } from '../../shared/CoverCount'
import { VideoResultRow } from '../../shared/VideoResultRow'
import { Artwork } from '../../shared/Artwork'
import { isMobile } from '../../services/platform'
import { Fragment, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Eye, ListChecks, Play } from 'lucide-react'
import type { Track } from '../../domain/track'
import { formatDuration, formatTrackDuration } from '../../shared/time'
import { PlayingMark } from '../../shared/PlayingMark'
import { useLocateCurrentRow } from '../../shared/useLocateCurrentRow'
import { useVisibleVideoPages } from '../../shared/useVisibleVideoPages'
import { usePlayerStore, type QueueSource } from '../player/playerStore'
import { TrackMenuButton } from './TrackMenuButton'
import { showTrackMenu } from './trackActionStore'
import { BatchTrackActions, useTrackSelection } from './useTrackSelection'

export function VideoPartsList({ tracks, visibleTracks = tracks, renderActions, renderDetails, videoCollection = false, locateCurrent = false, onOpenParts, playbackTracks = tracks, queueSource, totalCount, managementTracks=tracks, savedContainer = false, toolbar, listHeader, footer, loading = false, linkedFolderId }: {
  linkedFolderId?: number
  loading?: boolean
  toolbar?: { primary: ReactNode; actions: ReactNode }
  listHeader?: ReactNode
  footer?: ReactNode
  savedContainer?: boolean
  managementTracks?:Track[]
  totalCount?: number
  videoCollection?: boolean
  locateCurrent?: boolean
  onOpenParts?: (track: Track) => void
  queueSource?: QueueSource
  playbackTracks?: Track[]
  tracks: Track[]
  visibleTracks?: Track[]
  renderActions?: (track: Track) => ReactNode
  renderDetails?: (track: Track) => ReactNode
}) {
  const rules = useVisibilityRules()
  const [shownScope,setShownScope] = useState<string>(), [visibilityError,setVisibilityError] = useState('')
  const candidateScope = videoCollection ? queueSource?.collectionRef?.startsWith('season:') ? queueSource.collectionRef : undefined : tracks[0] ? videoScope(tracks[0].source.bvid) : undefined
  const scope = useManagedVisibilityScope(candidateScope, tracks, queueSource?.collectionRef, savedContainer)
  const playbackSource = queueSource ? { ...queueSource, visibilityManaged: Boolean(scope) } : undefined
  const rowHidden=(track:Track)=>Boolean(scope && (videoCollection ? !projectSeasonRows([track],playbackTracks,scope,rules).length : trackHidden(track,scope,rules)))
  const manage = Boolean(scope && shownScope === scope)
  const rawVisible = visibleTracks
  visibleTracks = !scope || manage ? rawVisible : videoCollection ? projectSeasonRows(rawVisible,playbackTracks,scope,rules) : rawVisible.filter(t=>!trackHidden(t,scope,rules))
  const change = async (selected:Track[], hidden:boolean) => { if(!scope)return;setVisibilityError('');try{await saveVisibility(selected.flatMap(t=>!hidden && videoCollection && !rules.some(r=>r.scope===scope&&r.target===t.source.bvid&&r.hidden) ? rules.filter(r=>r.scope===videoScope(t.source.bvid)&&r.hidden).map(r=>({...r,hidden:false})) : [visibilityChange(t,scope,hidden)]))}catch(e){setVisibilityError(String(e))} }
  const currentId = usePlayerStore(state => state.current?.id)
  const currentBvid = usePlayerStore(state => state.current?.source.bvid)
  const root = useRef<HTMLDivElement>(null)
  const rows = useRef<HTMLDivElement>(null)
  useListReveal(rows, loading, visibleTracks.length > 0)
  const activeTrack = visibleTracks.find(track => track.id === currentId)
    ?? (videoCollection ? visibleTracks.find(track => track.source.bvid === currentBvid) : undefined)
  const playingIndex = locateCurrent && activeTrack ? visibleTracks.indexOf(activeTrack) : -1
  const rendered = useListRows(visibleTracks, `video-parts:${queueSource?.collectionRef || tracks[0]?.source.bvid || ''}`, { through: playingIndex })
  useLocateCurrentRow(root, locateCurrent, activeTrack?.id)
  const byId = useMemo(() => new Map(playbackTracks.map(track => [track.id, track])), [playbackTracks])
  const selection = useTrackSelection(videoCollection ? visibleTracks.map(track => byId.get(track.id) ?? track) : visibleTracks)
  if (!toolbar && (!tracks.length || (!visibleTracks.length && !scope))) return null
  const listActions = <div className="video-parts-actions">{scope && <VisibilityControls scope={scope} rules={rules} shown={manage} exitLabel={toolbar ? '完成' : undefined} onShow={shown=>setShownScope(shown ? scope : undefined)} tracks={managementTracks} hiddenCount={tracks.filter(rowHidden).length}/>}<button type="button" className="collection-flat-button" aria-label="多选" title="多选" disabled={!visibleTracks.length} onClick={selection.enter}><ListChecks size={16}/><span>多选</span></button></div>
  return <div className={`video-parts-list${videoCollection ? ' video-collection-list video-result-layout' : ' parts-list'}`} ref={root}>
    {visibilityError && <p role="alert" className="inline-error">{visibilityError}</p>}
    {selection.selecting ? <BatchTrackActions selection={selection} total={visibleTracks.length} downloadScope={scope}
      linkedFolderId={linkedFolderId}
      onHide={scope ? async selected=>{await change(selected,true);selection.exit()} : undefined}/> :
      toolbar ? <div className="collection-detail-toolbar collection-unified-toolbar" data-managing={manage || undefined} role="toolbar" aria-label="合集播放与列表操作">
        <div className="collection-play-actions">{toolbar.primary}</div>
        <div className="collection-list-actions">{listActions}{toolbar.actions}</div>
      </div> :
      <div className="video-parts-toolbar">
        <span>{totalCount ?? visibleTracks.length} {videoCollection || (tracks.length === 1 && tracks[0].partCount === 1) ? '个视频' : '个分 P'}</span>
        {listActions}
      </div>}
    {listHeader}
    {tracks.length > 0 && !visibleTracks.length && <p className="batch-message">{scope && rawVisible.length ? '内容已隐藏，可在管理隐藏中恢复。' : '没有匹配的内容'}</p>}
    <div ref={rows} className={videoCollection ? 'video-result-list' : undefined}>{rendered.rows.map((track, index) => <Fragment key={track.id}><VideoPartsRow track={track} index={index}
      hidden={rowHidden(track)} visibilityScope={scope} restore={()=>void change([track],false)} active={track.id === activeTrack?.id} videoCollection={videoCollection} selecting={selection.selecting}
      checked={selection.ids.has(track.id)} onSelect={() => selection.toggle(track.id)}
      actionTrack={byId.get(track.id) ?? track} playbackTracks={playbackTracks} queueSource={playbackSource} onOpenParts={onOpenParts} renderActions={renderActions}/>
      {!selection.selecting && renderDetails?.(track)}
    </Fragment>)}{rendered.more && <div ref={rendered.tail} className="list-render-tail" aria-hidden="true"/>}</div>
    {!rendered.more && footer}
  </div>
}

function VideoPartsRow({ visibilityScope,hidden,restore,track, index, active, videoCollection, selecting, checked, onSelect, actionTrack, playbackTracks, queueSource, onOpenParts, renderActions }: {
  visibilityScope?: string; hidden:boolean; restore:()=>void;
  track: Track; index: number; active: boolean; videoCollection: boolean; selecting: boolean; checked: boolean
  onSelect: () => void; actionTrack: Track; playbackTracks: Track[]; queueSource?: QueueSource
  onOpenParts?: (track: Track) => void; renderActions?: (track: Track) => ReactNode
}) {
  const unavailable = useOfflinePlayback(state => offlineUnavailable(track, state, videoCollection || track.resolveParts === true || track.source.cid <= 0))
  const offline = useOfflinePlayback(state => state.offline)
  const { ref, pages, access } = useVisibleVideoPages(track.source.bvid, videoCollection && !offline, true)
  const count = track.partCount ?? pages?.length
  const openParts = onOpenParts && (count ?? 0) > 1 ? () => onOpenParts(track) : undefined
  const play = () => void usePlayerStore.getState().playFromList(playbackTracks, track.id, queueSource)
  const actions = { openParts, play, visibilityScope }
  const duration = track.durationSeconds || (count === 1 ? pages?.[0]?.durationSeconds : undefined)
  const title = videoCollection ? track.videoTitle || track.title : track.title
  const currentId = active ? track.id : undefined
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (selecting) return
    if (isMobile && openParts) openParts()
    else showTrackMenu(event, actionTrack, undefined, playbackTracks, actions)
  }
  const rowActions = !selecting && <>
    {hidden && <button type="button" className="visibility-restore" onClick={restore}><Eye size={16}/>恢复</button>}
    {!isMobile && renderActions?.(track)}
    <TrackMenuButton track={actionTrack} tracks={playbackTracks} actions={actions}/>
  </>
  if (videoCollection && !selecting) return <div ref={ref} className={`video-result-card${hidden ? ' visibility-hidden' : ''}`}
    data-offline-unavailable={unavailable || undefined} data-video-result-context onContextMenu={onContextMenu}>
    <VideoResultRow title={title} ariaLabel={`播放 ${title}`} coverUrl={track.coverUrl} durationSeconds={duration}
      count={count} playCount={track.playCount} publishedAt={track.publishedAt} access={access} currentId={currentId}
      disabled={hidden || unavailable} onClick={play} actions={rowActions}/>
  </div>

  const label = videoCollection ? index + 1 : track.partCount === 1 ? '视频' : `P${track.source.page}`
  return <div ref={ref} data-offline-unavailable={unavailable || undefined} data-current-row={currentId} className={`part-entry video-part-row${selecting ? '' : ' playing-row'}${hidden?' visibility-hidden':''}`} onContextMenu={onContextMenu}>
    {selecting ? <label className="video-part-select">
      <input className="track-select" type="checkbox" aria-label={`选择 ${title}`} checked={checked} onChange={onSelect}/>
      {track.coverUrl || videoCollection ? <span className="video-part-select-art"><Artwork src={track.coverUrl}/>{videoCollection && <CoverCount count={count}/>}</span> : <span>{label}</span>}<strong>{title}</strong><small>{formatTrackDuration(track.durationSeconds)}</small>
    </label> : <>
      <button type="button" className="video-part-play" disabled={hidden || unavailable} aria-current={active ? 'true' : undefined} aria-label={`播放 ${track.title}`} onClick={play}>
        <span className="video-part-index">{active ? <PlayingMark/> : label}</span><span className="video-part-copy"><strong>{track.title}</strong><span className="video-part-meta"><small className="video-part-inline-duration">{duration ? formatDuration(duration) : '—'}</small></span></span><small className="video-part-duration">{duration ? formatDuration(duration) : '—'}</small><Play size={14}/>
      </button>
      {rowActions}
    </>}
  </div>
}
