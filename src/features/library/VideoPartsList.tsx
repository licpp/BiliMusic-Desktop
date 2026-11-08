import { isMobile } from '../../services/platform'
import type { ReactNode } from 'react'
import { ListChecks, Play } from 'lucide-react'
import type { Track } from '../../domain/track'
import { formatDuration } from '../../shared/time'
import { usePlayerStore } from '../player/playerStore'
import { TrackMenuButton } from './TrackActions'
import { showTrackMenu } from './trackActionStore'
import { BatchTrackActions, useTrackSelection } from './useTrackSelection'

export function VideoPartsList({ tracks, visibleTracks = tracks, renderActions }: {
  tracks: Track[]
  visibleTracks?: Track[]
  renderActions?: (track: Track) => ReactNode
}) {
  const currentId = usePlayerStore(state => state.current?.id)
  const selection = useTrackSelection(visibleTracks)
  if (!visibleTracks.length) return null
  return <div className="parts-list video-parts-list">
    {selection.selecting ? <BatchTrackActions selection={selection} total={visibleTracks.length} /> :
      <div className="video-parts-toolbar">
        <span>{visibleTracks.length} 个分 P</span>
        <button type="button" className="collection-flat-button" onClick={selection.enter}><ListChecks size={16}/>多选分 P</button>
      </div>}
    {visibleTracks.map(track => <div key={track.id} className={`part-entry video-part-row${track.id === currentId ? ' current-part' : ''}`}
      onContextMenu={event => {
        event.stopPropagation()
        if (!selection.selecting) showTrackMenu(event, track, undefined, tracks)
      }}>
      {selection.selecting ?
        <label className="video-part-select">
          <input className="track-select" type="checkbox" aria-label={`选择 ${track.title}`} checked={selection.ids.has(track.id)} onChange={() => selection.toggle(track.id)} />
          <span>P{track.source.page}</span><strong>{track.title}</strong><small>{formatDuration(track.durationSeconds)}</small>
        </label> :
        <>
          <button type="button" className="video-part-play" aria-label={`播放 ${track.title}`} onClick={() => void usePlayerStore.getState().playFromList(tracks, track.id)}>
            <span>P{track.source.page}</span><strong>{track.title}</strong><small>{formatDuration(track.durationSeconds)}</small><Play size={14}/>
          </button>
          {!isMobile && renderActions?.(track)}
          <TrackMenuButton track={track} tracks={tracks} />
        </>}
    </div>)}
  </div>
}
