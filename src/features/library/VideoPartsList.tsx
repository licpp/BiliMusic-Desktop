import { isMobile } from '../../services/platform'
import { useEffect, useRef, type ReactNode } from 'react'
import { ChevronDown, ListChecks, Play } from 'lucide-react'
import type { Track } from '../../domain/track'
import { formatDuration } from '../../shared/time'
import { usePlayerStore } from '../player/playerStore'
import { TrackMenuButton } from './TrackActions'
import { showTrackMenu } from './trackActionStore'
import { BatchTrackActions, useTrackSelection } from './useTrackSelection'

export function VideoPartsList({ tracks, visibleTracks = tracks, renderActions, videoCollection = false, locateCurrent = false, onToggleParts, expandedBvid, renderParts, playbackTracks = tracks }: {
  videoCollection?: boolean
  locateCurrent?: boolean
  onToggleParts?: (track: Track) => void
  expandedBvid?: string
  renderParts?: (track: Track) => ReactNode
  playbackTracks?: Track[]
  tracks: Track[]
  visibleTracks?: Track[]
  renderActions?: (track: Track) => ReactNode
}) {
  const currentId = usePlayerStore(state => state.current?.id)
  const currentBvid = usePlayerStore(state => state.current?.source.bvid)
  const root = useRef<HTMLDivElement>(null)
  const located = useRef(false)
  const activeTrack = visibleTracks.find(track => track.id === currentId)
    ?? (videoCollection ? visibleTracks.find(track => track.source.bvid === currentBvid) : undefined)
  useEffect(() => {
    if (!locateCurrent || located.current || !activeTrack) return
    const row = root.current?.querySelector('.current-part')
    if (!row) return
    const frame = requestAnimationFrame(() => {
      located.current = true
      row.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [locateCurrent, activeTrack?.id])
  const selection = useTrackSelection(visibleTracks)
  if (!visibleTracks.length) return null
  return <div className="parts-list video-parts-list" ref={root}>
    {selection.selecting ? <BatchTrackActions selection={selection} total={visibleTracks.length} /> :
      <div className="video-parts-toolbar">
        <span>{visibleTracks.length} {videoCollection ? '个视频' : '个分 P'}</span>
        <button type="button" className="collection-flat-button" onClick={selection.enter}><ListChecks size={16}/>多选</button>
      </div>}
    {visibleTracks.map((track, index) => <div key={track.id}><div className={`part-entry video-part-row${track.id === activeTrack?.id ? ' current-part' : ''}`}
      onContextMenu={event => {
        event.stopPropagation()
        if (!selection.selecting) showTrackMenu(event, track, undefined, playbackTracks)
      }}>
      {selection.selecting ?
        <label className="video-part-select">
          <input className="track-select" type="checkbox" aria-label={`选择 ${track.title}`} checked={selection.ids.has(track.id)} onChange={() => selection.toggle(track.id)} />
          <span>{videoCollection ? index + 1 : `P${track.source.page}`} </span><strong>{track.title}</strong><small>{formatDuration(track.durationSeconds)}</small>
        </label> :
        <>
          <button type="button" className="video-part-play" aria-label={`播放 ${track.title}`} onClick={() => void usePlayerStore.getState().playFromList(playbackTracks, track.id)}>
            <span>{videoCollection ? index + 1 : `P${track.source.page}`} </span><strong>{track.title}</strong><small>{formatDuration(track.durationSeconds)}</small><Play size={14}/>
          </button>
          {!isMobile && renderActions?.(track)}
          {onToggleParts && <button type="button" className="icon-action" aria-label="查看分 P" title="查看分 P" aria-expanded={expandedBvid === track.source.bvid} onClick={() => onToggleParts(track)}><ChevronDown size={16}/></button>}
          <TrackMenuButton track={track} tracks={playbackTracks} />
        </>}
    </div>{expandedBvid === track.source.bvid && renderParts?.(track)}</div>)}
  </div>
}
