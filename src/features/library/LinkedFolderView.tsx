import { useListRows } from '../../shared/useListRows'
import { useListDataDuringNavigation, useListReveal } from '../../shared/useListMotion'
import { ListSkeleton } from '../../shared/ListSkeleton'
import { offlineUnavailable, useOfflinePlayback } from '../player/offlinePlayback'
import { accountQueryKey } from '../../services/queryKeys'
import {ListSort,useListSort} from '../../shared/ListSort'
import {sortList} from '../../services/listOrdering'
import { ListSearch, matchesListSearch } from '../../shared/ListSearch'
import { formatDuration } from '../../shared/time'
import { formatPlayCount } from '../../shared/count'
import { useVisibleVideoPages } from '../../shared/useVisibleVideoPages'
import { VideoAccessBadge } from '../../shared/VideoAccessBadge'
import { favoriteVideoExpired, favoriteVideoTrack } from '../../services/mediaSources'
import { seasonPlaybackQueue } from '../player/playerStore'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ListChecks, Play, Plus, RefreshCw } from 'lucide-react'
import { changeLinkedVideo, commandErrorMessage, getLinkedFolder, getVideoParts } from '../../services/desktopApi'
import type { FavoriteVideo } from '../../domain/bilibili'
import type { Playlist } from '../../domain/library'
import { accountEpoch } from '../../services/accountScope'
import { toTrack } from '../../services/collectionTrack'
import { PlayingMark } from '../../shared/PlayingMark'
import { Artwork } from '../../shared/Artwork'
import { ActionMenu } from '../../shared/ActionMenu'
import { useLocateCurrentRow } from '../../shared/useLocateCurrentRow'
import { useRowContextMenu } from '../../shared/useRowContextMenu'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { linkedFolderKey, reloadLinkedFolder } from '../../services/linkedFolders'
import { VideoPartsList } from './VideoPartsList'
import { usePlayerStore } from '../player/playerStore'
import { PlaylistMenu } from './PlaylistEntry'
import { useTrackSelection } from './useTrackSelection'
import { LinkedSelectionActions } from './LinkedSelectionActions'
import { useCompactLayout } from '../../shared/useCompactLayout'

const wideSelectionToolbarWidth = 820

export function LinkedFolderView({ playlist, onUnlink }: { playlist: Playlist & { biliFolderId: number }; onUnlink: () => void }) {
  const { biliFolderId: folderId, name } = playlist
  const client = useQueryClient()
  const compact = useCompactLayout()
  const toolbar = useRef<HTMLDivElement>(null)
  const [narrowToolbar, setNarrowToolbar] = useState(false)
  useLayoutEffect(() => {
    if (compact || !toolbar.current) return
    const element = toolbar.current
    const update = (width: number) => setNarrowToolbar(width < wideSelectionToolbarWidth)
    update(element.clientWidth)
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [compact])
  const offline = useOfflinePlayback()
  const folder = useQuery({ queryKey: linkedFolderKey(folderId), queryFn: () => getLinkedFolder(folderId) })
  const visibleFolder = useListDataDuringNavigation(folder.data, folderId)
  const loadingFolder = folder.isLoading || Boolean(folder.data && !visibleFolder)
  const [filter, setFilter] = useState('')
  const sortEntity=`linkedFolder:${folderId}`,listSort=useListSort(sortEntity)
  const orderedVideos=sortList(visibleFolder?.videos||[],listSort.rule,video=>({id:video.bvid,name:video.title,date:video.pubtime||listSort.dates[video.bvid],playCount:video.cnt_info?.play??listSort.playCounts[video.bvid]}))
  const visibleVideos = orderedVideos.filter(video => matchesListSearch(filter, video.title, video.bvid))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [expanded, setExpanded] = useState<string>()
  const [confirm, setConfirm] = useState<FavoriteVideo>()
  const [bvid, setBvid] = useState('')
  const [adding, setAdding] = useState(false)
  const refreshGeneration = useRef(0)
  const currentBvid = usePlayerStore(state => state.current?.source.bvid)
  const list = useRef<HTMLDivElement>(null)
  useListReveal(list, loadingFolder, visibleVideos.length > 0)
  const initialVideo = useRef<string | undefined>(usePlayerStore.getState().current?.source.bvid)
  const playingIndex = visibleVideos.findIndex(video => video.bvid === currentBvid)
  const rendered = useListRows(visibleVideos, `linked-folder:${folderId}`, { through: playingIndex })
  const locate = playingIndex >= 0 ? currentBvid : undefined
  useLocateCurrentRow(list, true, locate)
  useEffect(() => {
    if (!folder.data || !initialVideo.current || !folder.data.videos.some(video => video.bvid === initialVideo.current)) return
    const bvid = initialVideo.current
    initialVideo.current = undefined
    setExpanded(value => value || bvid)
  }, [folder.data])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await action() }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    const epoch = accountEpoch()
    setRefreshing(true)
    setRefreshError('')
    try { await reloadLinkedFolder(client, folderId) }
    catch (cause) { if (generation === refreshGeneration.current && epoch === accountEpoch()) setRefreshError(commandErrorMessage(cause)) }
    finally { if (generation === refreshGeneration.current && epoch === accountEpoch()) setRefreshing(false) }
  }, [client, folderId])
  useEffect(() => {
    if (!offline.offline) void refresh()
    return () => { refreshGeneration.current++ }
  }, [offline.offline, refresh])

  const change = async (videoId: string, add: boolean) => {
    const epoch = accountEpoch()
    const updated = await changeLinkedVideo(folderId, videoId, add)
    if (epoch !== accountEpoch()) return
    setConfirm(undefined)
    setBvid('')
    setAdding(false)
    client.setQueryData(linkedFolderKey(folderId), updated)
    await client.invalidateQueries({ queryKey: accountQueryKey('playlists') })
  }

  const queue = visibleVideos.map(favoriteVideoTrack)
  const selection = useTrackSelection(queue)
  const selectionLayout = compact || narrowToolbar ? 'compact' : 'wide'
  const folderChanged = (updated: import('../../domain/bilibili').LinkedFolder) => {
    client.setQueryData(linkedFolderKey(folderId), updated)
    void client.invalidateQueries({ queryKey: accountQueryKey('playlists') })
  }
  return <section className="library-view linked-folder">
    <header>
      <div><span className="eyebrow">BILIBILI</span>
        <div className="linked-folder-title"><h2>{folder.data?.name || name}</h2>
          <span className="sync-label" role="status" title={folder.data ? new Date(folder.data.refreshedAt * 1000).toLocaleString('zh-CN') : undefined}>
            {refreshing ? '正在同步…' : refreshError ? '同步失败' : folder.data ? '已同步' : '等待同步'}
          </span>
        </div>
        <p>{folder.data?.videos.length ?? playlist.trackCount} 个视频 · 关联 B 站收藏夹</p>
      </div>
    </header>
    <div ref={toolbar} className="linked-folder-tools" data-selection={selection.selecting ? selectionLayout : undefined}>
      {selection.selecting && <LinkedSelectionActions compact={selectionLayout === 'compact'} folderId={folderId} total={queue.length} selection={selection} onFolderChanged={folderChanged}
        confirmDialog={(body, close) => <CollectionDialog title="从 B 站收藏夹移除" onClose={close}>{body}</CollectionDialog>}/>}
      <div className="library-list-toolbar">
        {!selection.selecting && <div className="collection-actions">
          <button type="button" className="collection-primary" disabled={busy} onClick={() => setAdding(value => !value)}><Plus size={16}/>添加视频</button>
          <button type="button" className="collection-flat-button" disabled={!queue.length || busy} onClick={() => { setAdding(false); selection.enter() }}><ListChecks size={16}/>多选</button>
          <PlaylistMenu playlist={playlist} onRefresh={refresh} onRemoved={onUnlink}/>
        </div>}
        <div className="library-toolbar-icons">
          <ListSort entity={sortEntity}/>
          <ListSearch query={filter} onChange={setFilter} count={visibleVideos.length} label="搜索歌单中的视频"/>
        </div>
      </div>
    </div>
    {filter.trim() && !visibleVideos.length && <p className="collection-empty">没有匹配的视频</p>}
    {refreshError && <div className="linked-refresh-error" role="alert">
      <span>{folder.data ? '已保留上次同步的内容。' : ''}{refreshError}</span>
      <button type="button" className="collection-flat-button" onClick={() => void refresh()}><RefreshCw size={15}/>重试</button>
    </div>}
    {adding && <form className="playlist-management" onSubmit={event => {
      event.preventDefault()
      if (!busy && bvid.trim()) void run(() => change(bvid.trim(), true))
    }}>
      <input autoFocus value={bvid} onChange={event => setBvid(event.target.value)} aria-label="视频 BV 号" placeholder="输入视频 BV 号" maxLength={32}/>
      <button type="submit" className="collection-flat-button" disabled={busy || !bvid.trim()}>添加到 B 站收藏夹</button>
    </form>}
    {confirm && <CollectionDialog title="从 B 站收藏夹移除" onClose={() => { if (!busy) setConfirm(undefined) }}>
      <p>从 B 站收藏夹移除整个视频「{confirm.title || confirm.bvid}」及其全部分 P？</p>
      {error && <p role="alert" className="inline-error">{error}</p>}
      <footer>
        <button type="button" className="collection-flat-button" disabled={busy} onClick={() => setConfirm(undefined)}>取消</button>
        <button type="button" className="collection-flat-button action-danger" disabled={busy} onClick={() => void run(() => change(confirm.bvid, false))}>确认移除视频</button>
      </footer>
    </CollectionDialog>}
    {error && !confirm && <p role="alert" className="inline-error">{error}</p>}
    {!visibleFolder && (loadingFolder || refreshing) && <ListSkeleton wide label="正在读取收藏夹" />}
    {folder.error && !refreshError && !refreshing && !folder.data && <p role="alert" className="inline-error">{commandErrorMessage(folder.error)}</p>}
    {visibleFolder?.videos.length === 0 && <p className="batch-message">这个收藏夹里还没有视频</p>}
    <div className="result-list" ref={list}>{rendered.rows.map((video, index) => selection.selecting ?
      <article key={video.bvid} data-offline-unavailable={offlineUnavailable(queue[index], offline) || undefined} className="result-card"><label className="result-main linked-select-row">
        <input className="track-select" type="checkbox" aria-label={`选择 ${video.title || video.bvid}`} checked={selection.ids.has(queue[index].id)} onChange={() => selection.toggle(queue[index].id)}/>
        <span className="result-cover"><Artwork src={video.cover}/></span><span className="result-copy"><strong>{video.title || video.bvid}</strong><small>{favoriteVideoExpired(video) ? '已失效' : video.duration ? formatDuration(video.duration) : '时长未知'}</small></span>
      </label></article> :
      <LinkedVideoRow key={video.bvid} video={video} queue={queue} title={name} current={currentBvid === video.bvid}
      expanded={expanded === video.bvid} busy={busy} onOpen={() => setExpanded(value => value === video.bvid ? undefined : video.bvid)}
      onRemove={() => { setError(''); setConfirm(video) }}/>) }
      {rendered.more && <div ref={rendered.tail} className="list-render-tail" aria-hidden="true"/>}
    </div>
  </section>
}

function LinkedVideoRow({ video, queue, title, expanded, busy, current, onOpen, onRemove }: {
  queue: import('../../domain/track').Track[]; title: string
  video: FavoriteVideo; expanded: boolean; busy: boolean; current: boolean; onOpen: () => void; onRemove: () => void
}) {
  const { position, onContextMenu } = useRowContextMenu()
  const offline = useOfflinePlayback()
  const expired = favoriteVideoExpired(video)
  const { ref, pages, access } = useVisibleVideoPages<HTMLElement>(video.bvid, !expired && !offline.offline, true)
  const entry = queue.find(track => track.source.bvid === video.bvid)
  const unavailable = expired && !offline.offline || !!entry && offlineUnavailable(entry, offline)
  const multiple = !offline.offline && (pages?.length ?? 0) > 1
  const playVideo = async () => {
    if (unavailable) return
    if (offline.offline) {
      if (entry && !offlineUnavailable(entry)) await usePlayerStore.getState().playFromList(queue, entry.id, { kind: 'season', title, origin: 'linked-favorite' })
      return
    }
    const detail = await getVideoParts(video.bvid)
    const tracks = detail.parts.map(part => toTrack(detail, part))
    if (tracks[0]) await usePlayerStore.getState().playFromList(seasonPlaybackQueue(queue, tracks[0], tracks), tracks[0].id, { kind: 'season', title, origin: 'linked-favorite' })
  }
  const [playError, setPlayError] = useState('')
  return <article ref={ref} data-offline-unavailable={unavailable || undefined} className="result-card">
    <div className={expanded ? 'search-result-heading' : 'search-result-heading playing-row'} data-current-row={current ? video.bvid : undefined} onContextMenu={onContextMenu}>
      <button type="button" className="result-main" disabled={unavailable} aria-current={current && !expanded ? 'true' : undefined} aria-expanded={multiple ? expanded : undefined} onClick={() => { if (multiple) onOpen(); else void playVideo().catch(error => setPlayError(commandErrorMessage(error))) }}>
        <span className="result-cover" onClick={event => { event.stopPropagation(); void playVideo().catch(error => setPlayError(commandErrorMessage(error))) }}><Artwork src={video.cover}/><i><Play size={17}/></i>{current && !expanded && <PlayingMark/>}<VideoAccessBadge access={access} onCover/></span>
        <span className="result-copy"><strong>{video.title || video.bvid}</strong><small className="result-byline"><span>{expired ? '已失效' : video.duration ? formatDuration(video.duration) : '时长未知'}{video.cnt_info?.play !== undefined ? ` · ${formatPlayCount(video.cnt_info.play)} 次播放` : ''}</span></small></span>
        {multiple && (expanded ? <ChevronDown size={18}/> : <ChevronRight size={18}/>)}
      </button>
      <ActionMenu sheet label={`操作 ${video.title || video.bvid}`} contextPosition={position}>{close => <>
        {multiple && <button role="menuitem" onClick={() => { close(); onOpen() }}>{expanded ? '收起分 P' : '展开分 P'}</button>}
        <button role="menuitem" disabled={busy} onClick={() => { close(); onRemove() }}>从 B 站收藏夹移除</button>
      </>}</ActionMenu>
    </div>
    {playError && <p role="alert" className="inline-error">{playError}</p>}
    {expanded && multiple && <LinkedVideoParts bvid={video.bvid} queue={queue} title={title}/>}
  </article>
}

function LinkedVideoParts({ bvid, queue, title }: { bvid: string; queue: import('../../domain/track').Track[]; title: string }) {
  const detail = useQuery({ queryKey: accountQueryKey('collection-parts', bvid), queryFn: () => getVideoParts(bvid) })
  if (detail.isLoading) return <p className="batch-message">正在加载分 P…</p>
  if (detail.error) return <p role="alert" className="inline-error">{commandErrorMessage(detail.error)}</p>
  const video = detail.data
  if (!video?.parts.length) return <p className="batch-message">暂无可播放内容</p>
  const tracks = video.parts.map(part => toTrack(video, part))
  return <VideoPartsList savedContainer locateCurrent queueSource={{ kind: 'season', title, origin: 'linked-favorite' }} playbackTracks={seasonPlaybackQueue(queue, tracks[0], tracks)} tracks={tracks}/>
}
