import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ListMusic, Play, ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import type { Track } from '../../domain/track'
import { isMobile } from '../../services/platform'
import { ActionMenu } from '../../shared/ActionMenu'
import { useRowContextMenu, type MenuPosition } from '../../shared/useRowContextMenu'
import { useVisibleVideoPages } from '../../shared/useVisibleVideoPages'
import { PlayingMark } from '../../shared/PlayingMark'
import { useLocateCurrentRow } from '../../shared/useLocateCurrentRow'
import { formatDuration } from '../../shared/time'
import { chooseTrackPlaylist } from '../library/trackActionStore'
import { presentQueue } from './queueGroups'
import { prepareSeasonQueueEntry, usePlayerStore } from './playerStore'

export function QueueList({ open }: { open: boolean }) {
  const queue = usePlayerStore(state => state.queue)
  const source = usePlayerStore(state => state.queueSource)
  const currentId = usePlayerStore(state => state.current?.id)
  const { structured, groups, partsOnly } = useMemo(() => presentQueue(queue, source?.kind), [queue, source?.kind])
  const root = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const activeGroup = groups.find(item => item.tracks.some(track => track.id === currentId))
  const activeFolder = activeGroup && activeGroup.tracks.length > 1
  const activeExpanded = activeGroup ? expanded[activeGroup.key] ?? true : false
  const rowId = activeFolder && !activeExpanded ? activeGroup.key : activeGroup ? currentId : undefined

  useEffect(() => { if (!open) setExpanded({}) }, [open])
  useLocateCurrentRow(root, open, rowId)

  return <div className="queue-list queue-tree" ref={root}>
    {groups.map((item, index) => {
      const active = item === activeGroup
      return item.tracks.length > 1 ? <QueueVideo key={item.key} id={item.key} tracks={item.tracks} activeId={active ? currentId : undefined}
        expanded={open && (expanded[item.key] ?? active)} onToggle={() => setExpanded(value => ({ ...value, [item.key]: !(value[item.key] ?? active) }))}
        index={index} count={groups.length}/> :
        <QueueTrack key={item.key} track={item.tracks[0]} active={active} observe={open} group={structured} label={partsOnly ? `P${item.tracks[0].source.page}` : String(index + 1)} groupIndex={index} groupCount={groups.length}/>
    })}
    {!queue.length && <p className="queue-empty">队列为空，可以从音乐库或搜索结果添加歌曲。</p>}
  </div>
}

function QueueVideo({ id, tracks, activeId, expanded, onToggle, index, count }: {
  id: string; tracks: Track[]; activeId?: string; expanded: boolean; onToggle: () => void; index: number; count: number
}) {
  const first = tracks[0]
  const menu = useRowContextMenu()
  const title = first.videoTitle || first.title
  const ids = tracks.map(track => track.id)
  return <div className="queue-video">
    <div className="queue-entry queue-video-heading playing-row" onContextMenu={menu.onContextMenu} data-current-row={!expanded && activeId ? id : undefined}>
      <button type="button" className="queue-row-main" aria-current={!expanded && activeId ? 'true' : undefined} onClick={() => void usePlayerStore.getState().play(first)}>
        <span className="queue-row-number">{!expanded && activeId ? <PlayingMark/> : index + 1}</span>
        <strong>{title}</strong>
      </button>
      <button type="button" className="queue-parts-toggle" aria-label={expanded ? '收起选集' : '展开选集'} aria-expanded={expanded} onClick={onToggle}>
        <ChevronDown size={16} className={expanded ? 'rotated' : undefined}/>
      </button>
      <QueueActions contextPosition={menu.position} title={title} ids={ids} tracks={tracks} onPlay={() => void usePlayerStore.getState().play(first)} group canUp={index > 0} canDown={index < count - 1}/>
    </div>
    {expanded && <div className="queue-video-parts">
      {tracks.map((track, partIndex) => <QueueTrack key={track.id} track={track} active={track.id === activeId} label={`P${track.source.page}`} child
        groupIndex={partIndex} groupCount={tracks.length}/>)}
    </div>}
  </div>
}

function QueueTrack({ track, active, label, groupIndex, groupCount, child = false, observe = false, group = false }: {
  track: Track; active: boolean; label: string; groupIndex: number; groupCount: number; child?: boolean; observe?: boolean; group?: boolean
}) {
  const menu = useRowContextMenu()
  const { ref, pages } = useVisibleVideoPages(track.source.bvid, observe && Boolean(track.resolveParts) && track.partCount === undefined)
  useEffect(() => {
    if (observe && track.resolveParts && track.partCount === undefined && pages?.length) void prepareSeasonQueueEntry(track).catch(() => undefined)
  }, [observe, track, pages])
  const play = () => void usePlayerStore.getState().play(track)
  return <div ref={ref} className={`queue-entry queue-track-row playing-row${child ? ' queue-part-row' : ''}`} data-current-row={active ? track.id : undefined}
    onContextMenu={menu.onContextMenu}>
    <button type="button" className="queue-row-main" aria-current={active ? 'true' : undefined} aria-label={`播放 ${track.title}`} onClick={play}>
      <span className="queue-row-number">{active ? <PlayingMark/> : label}</span>
      <strong>{track.title}</strong><small className="queue-row-duration">{formatDuration(track.durationSeconds)}</small>
    </button>
    <QueueActions contextPosition={menu.position} title={track.title} ids={[track.id]} tracks={[track]} onPlay={play} group={group} flat={!group && !child}
      canUp={groupIndex > 0} canDown={groupIndex < groupCount - 1}/>
  </div>
}

function QueueActions({ contextPosition, title, ids, tracks, onPlay, group, flat = false, canUp, canDown }: {
  contextPosition?: MenuPosition; title: string; ids: string[]; tracks: Track[]; onPlay: () => void; group: boolean; flat?: boolean; canUp: boolean; canDown: boolean
}) {
  const move = (direction: -1 | 1) => {
    const state = usePlayerStore.getState()
    if (flat) state.moveInQueue(ids[0], direction)
    else state.moveQueueRows(ids, direction, group)
  }
  return <ActionMenu sheet={isMobile} contextPosition={contextPosition} label={`队列操作：${title}`}>{close => <>
    <button onClick={() => { close(); onPlay() }}><Play size={16}/>播放</button>
    <button onClick={() => { close(); chooseTrackPlaylist(tracks) }}><ListMusic size={16}/>加入歌单…</button>
      <button disabled={!canUp} onClick={() => { close(); move(-1) }}><ArrowUp size={16}/>上移</button>
      <button disabled={!canDown} onClick={() => { close(); move(1) }}><ArrowDown size={16}/>下移</button>
      <button onClick={() => { close(); usePlayerStore.getState().removeQueueRows(ids) }}><Trash2 size={16}/>{ids.length > 1 ? '移出这一组' : '移出队列'}</button>
  </>}</ActionMenu>
}
