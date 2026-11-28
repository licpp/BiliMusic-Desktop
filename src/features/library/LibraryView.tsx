import { useListRows } from '../../shared/useListRows'
import { afterListMotion } from '../../shared/navigationListMotion'
import { useListDataDuringNavigation, useListReveal } from '../../shared/useListMotion'
import { ListSkeleton } from '../../shared/ListSkeleton'
import { offlineUnavailable, useOfflinePlayback } from '../player/offlinePlayback'
import { trackSubtitle } from '../../domain/sourceTitle'
import { accountQueryKey } from '../../services/queryKeys'
import { accountEpoch } from '../../services/accountScope'
import { useQuery,useQueryClient } from '@tanstack/react-query'
import { Heart,Library,ListPlus,Play } from 'lucide-react'
import { useEffect,useMemo,useRef,useState } from 'react'
import type { Track } from '../../domain/track'
import { commandErrorMessage, FAVORITES_PLAYLIST_ID, listLibraryTracks, listPlaylistTracks, listRecentTracks, removeTracksFromPlaylist, reorderPlaylist, toggleStoredFavorite } from '../../services/desktopApi'
import { createPortal } from 'react-dom'
import type { Playlist } from '../../domain/library'
import { playlistTrackTitle, sortPlaylistTracks, sortTracks } from '../../services/listOrdering'
import { playlistEntity } from '../../services/listPreferences'
import { hydrateSourceTitles } from '../player/sourceTitles'
import { hydrateVisibleTracks } from '../sync/librarySync'
import { ActionMenu } from '../../shared/ActionMenu'
import { Artwork } from '../../shared/Artwork'
import { ListBackToTop } from '../../shared/ListBackToTop'
import { useOrganizer } from '../../shared/useOrganizer'
import { ListSearch,matchesTrackSearch } from '../../shared/ListSearch'
import { ListSort,useListSort } from '../../shared/ListSort'
import { PlayingMark } from '../../shared/PlayingMark'
import type { TabOption } from '../../shared/SegmentedTabs'
import { formatTrackDuration } from '../../shared/time'
import { useCompactLayout } from '../../shared/useCompactLayout'
import { useLocateCurrentRow } from '../../shared/useLocateCurrentRow'
import { SwipeTabPages } from '../../shared/SwipeTabPages'
import { DownloadsView } from '../downloads/DownloadsView'
import { usePlayerStore } from '../player/playerStore'
import { PlaylistMenu } from './PlaylistEntry'
import { showTrackMenu } from './trackActionStore'
import { TrackMenuButton } from './TrackMenuButton'
import { BatchTrackActions,useTrackSelection } from './useTrackSelection'
import { useImportedPlaylist } from './useImportedPlaylist'
import { HistoryDeleteDialog } from './HistoryDeleteDialog'
import { ReplacementDialog } from './ReplacementDialog'
import { PlaylistDuplicateReview, usePlaylistDuplicateNotice } from './PlaylistDuplicates'
import { canEditPlaylistTracks } from './playlistEditing'
import type { ImportedEntry, ImportedEntriesSnapshot } from '../../domain/importedEntry'

export type LibraryTab = 'saved' | 'recent' | 'downloads'
const libraryTabs: TabOption<LibraryTab>[] = [{ id: 'saved', label: '已收藏' }, { id: 'recent', label: '最近播放' }, { id: 'downloads', label: '下载' }]
export function MusicLibraryView({ tab, onTabChange, fill, active = true }: { tab: LibraryTab; onTabChange: (tab: LibraryTab) => void; fill?: boolean; active?: boolean }) {
  return <div className="music-library">
    <SwipeTabPages tabs={libraryTabs} value={tab} onChange={onTabChange} idPrefix="library-tab" panelId="music-library-panel"
      label="音乐库视图" className="library-tabs" fill={fill}
      renderPanel={(pane, selected) => pane === 'downloads' ? <DownloadsView active={active && selected}/> : <LibraryView recent={pane === 'recent'} active={active && selected}/>}/>
  </div>
}

export function LibraryView({ recent = false, active = true, playlist, onPlaylistDeleted, onRematchImported, onPreviewLyrics, lyricsPresent }: {
  recent?: boolean; active?: boolean; playlist?: Playlist; onPlaylistDeleted?: () => void
  onRematchImported?: (playlist: Playlist) => void; onPreviewLyrics?: () => void; lyricsPresent?: boolean
}) {
  const client = useQueryClient()
  const compact = useCompactLayout()
  const play = usePlayerStore((state) => state.playFromList)
  const playAll = usePlayerStore((state) => state.playAll)
  const offline = useOfflinePlayback()
  const enqueue = usePlayerStore((state) => state.enqueue)
  const updatePlayerTrack = usePlayerStore((state) => state.updateTrack)
  const tracks = useQuery({ queryKey: accountQueryKey('library', recent ? 'recent' : 'saved', playlist?.id), queryFn: () => playlist ? listPlaylistTracks(playlist.id) : recent ? listRecentTracks() : listLibraryTracks(false, true) })
  const trackRows = useListDataDuringNavigation(tracks.data, recent ? 'recent' : playlist?.id)
  const loadingTracks = tracks.isLoading || Boolean(tracks.data && !trackRows)
  const imported = useImportedPlaylist(playlist)
  const [replacement,setReplacement] = useState<ImportedEntry>()
  const [replaceTrack,setReplaceTrack] = useState<Track>()
  const currentId = usePlayerStore(state => state.current?.id)
  const grid = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState('')
  const sortEntity=playlist?playlistEntity(playlist):'view:saved'
  const listSort=useListSort(sortEntity)
  const isFavorites = playlist?.id === FAVORITES_PLAYLIST_ID
  const editable = canEditPlaylistTracks(playlist)
  const visibleTracks = useMemo(() => {
    const sorted = playlist
      ? sortPlaylistTracks(trackRows || [], listSort.rule, listSort.dates, listSort.playCounts, imported.byTrack, editable)
      : sortTracks(trackRows || [], recent ? 'source:asc' : listSort.rule, listSort.dates, listSort.playCounts)
    if (!filter.trim()) return sorted
    return sorted.filter(track => {
      const song = imported.byTrack.get(track.id)?.song
      return matchesTrackSearch(track, filter) || Boolean(song &&
        `${song.title} ${song.artists.join(' ')} ${song.album || ''}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
    })
  }, [trackRows, playlist, recent, listSort.rule, listSort.dates, listSort.playCounts, imported.byTrack, filter, editable])
  const playingIndex = playlist ? visibleTracks.findIndex(track => track.id === currentId) : -1
  useLocateCurrentRow(grid, Boolean(playlist) && active, playingIndex >= 0 ? currentId : undefined)
  useListReveal(grid, loadingTracks, visibleTracks.length > 0, active)
  const selection = useTrackSelection(visibleTracks)
  useEffect(() => { setFilter(''); selection.exit() }, [playlist?.id, recent])
  const [historyDelete, setHistoryDelete] = useState<Track[]>()
  const [deleteNotice, setDeleteNotice] = useState('')
  const [favoriteError, setFavoriteError] = useState('')
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, boolean>>({})
  const [favoritePending, setFavoritePending] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!active || !trackRows?.length) return
    return afterListMotion(() => {
      const unknownDurations = trackRows.filter(track => !track.durationSeconds)
      const knownDurations = trackRows.filter(track => track.durationSeconds > 0)
      void hydrateSourceTitles([...unknownDurations, ...knownDurations].map(track => track.id), client).catch(() => undefined)
      void hydrateVisibleTracks(trackRows, client).catch(() => undefined)
    })
  }, [trackRows, client, active])
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: accountQueryKey('library') }), client.invalidateQueries({ queryKey: accountQueryKey('playlists') }), client.invalidateQueries({ queryKey: accountQueryKey('home-recent') })])
  const organizer = useOrganizer(
    editable && !filter.trim() ? visibleTracks.map(track => ({ id: track.id, name: playlistTrackTitle(track) })) : [],
    '整理曲目',
    {
      expected: trackRows?.map(track => track.id),
      saveOrder: async (expected, ordered) => {
        const epoch = accountEpoch()
        await reorderPlaylist(playlist!.id, expected, ordered)
        if (epoch !== accountEpoch()) return
        await Promise.all([refresh(), client.invalidateQueries({ queryKey: accountQueryKey('list-preferences') })])
      },
    },
  )
  const displayTracks = organizer.order(visibleTracks, track => track.id)
  const rendered = useListRows(displayTracks, sortEntity, { active, through: playingIndex, manualFallback: true })
  const duplicates = usePlaylistDuplicateNotice(editable && active ? playlist!.id : undefined, trackRows ?? [])
  useEffect(() => { organizer.cancel(); setReplaceTrack(undefined) }, [playlist?.id])
  const replaced = (snapshot:ImportedEntriesSnapshot) => {
    const epoch=accountEpoch(),entryId=replacement?.entryId
    client.setQueryData(accountQueryKey('imported-entries',playlist?.id),snapshot)
    setReplacement(undefined)
    void refresh().then(()=>requestAnimationFrame(()=>{
      if(epoch!==accountEpoch())return
      const row=[...document.querySelectorAll<HTMLElement>('[data-import-entry]')].find(el=>el.dataset.importEntry===entryId)
      row?.querySelector<HTMLButtonElement>('[aria-label="歌曲操作"]')?.focus({preventScroll:true})
    }))
  }
  const toggleFavorite = async (track: Track) => {
    if (favoritePending.has(track.id)) return
    const previous = favoriteOverrides[track.id] ?? track.liked
    setFavoriteOverrides(value => ({ ...value, [track.id]: !previous }))
    setFavoritePending(value => new Set(value).add(track.id)); setFavoriteError('')
    try {
      const liked = await toggleStoredFavorite(track.id)
      setFavoriteOverrides(value => ({ ...value, [track.id]: liked }))
      updatePlayerTrack({ ...track, liked })
      await refresh()
      setFavoriteOverrides(value => { const copy = { ...value }; delete copy[track.id]; return copy })
    } catch (cause) {
      setFavoriteOverrides(value => ({ ...value, [track.id]: previous }))
      setFavoriteError(`收藏失败，已恢复原状态：${commandErrorMessage(cause)}`)
    } finally { setFavoritePending(value => { const copy = new Set(value); copy.delete(track.id); return copy }) }
  }
  return <section className={`library-view${playlist ? '' : ' library-tab-content'}`}>
    <header><div><span className="eyebrow">YOUR COLLECTION</span><h2>{playlist?.name || (recent ? '最近播放' : '已收藏')}</h2><p>{playlist ? `${playlist.trackCount} 首歌曲 · ${playlist.isSystem ? '默认歌单，点击红心即可收藏或取消喜欢。' : '本地歌单'}` : recent ? '按最近一次播放整理，播放历史不会自动加入收藏。' : '收藏喜欢的歌曲，或将歌曲加入歌单，统一整理在这里。'}</p></div></header>

    {selection.selecting ? <BatchTrackActions allowAutoMatch selection={selection} total={visibleTracks.length} onMatched={ids => { void duplicates.review(ids).catch(() => undefined) }} onDelete={recent ? selected => setHistoryDelete(selected) : undefined} onRemove={playlist ? async selected => {
      await removeTracksFromPlaylist(playlist.id, selected.map(track => track.id))
      if (isFavorites) selected.forEach(track => updatePlayerTrack({ ...track, liked: false }))
      await refresh()
    } : undefined} /> : <div className={`library-list-toolbar${compact ? ' library-list-toolbar-compact' : ''}`}><div className="collection-actions">
      {!compact && <button disabled={organizer.editing || !visibleTracks.length} onClick={selection.enter}>多选</button>}
      <button className="collection-primary" disabled={!visibleTracks.some(track => !offlineUnavailable(track, offline))} onClick={() => void playAll(visibleTracks)}><Play size={16}/>{filter.trim() ? '播放搜索结果' : '播放全部'}</button>
      {!compact && <button disabled={!visibleTracks.length} onClick={() => enqueue(visibleTracks)}><ListPlus size={16}/>全部加入队列</button>}
    </div><div className="library-toolbar-icons">
      {!recent && !organizer.editing && <ListSort entity={sortEntity} customOrder={editable}/>}
      {editable && organizer.controls}
      <ListSearch query={filter} onChange={setFilter} count={visibleTracks.length} disabled={organizer.editing}/>
      {playlist ? <PlaylistMenu playlist={playlist} disabled={organizer.editing} onRemoved={onPlaylistDeleted} missingCount={imported.missing.length} onRematch={imported.missing.length && onRematchImported ? () => onRematchImported(playlist) : undefined}
        onFindDuplicates={editable ? () => duplicates.setOpen(true) : undefined}
        listActions={compact ? {select: selection.enter, play: () => { void playAll(visibleTracks) }, enqueue: () => enqueue(visibleTracks), disabled: !visibleTracks.length} : undefined}/> : compact && <ActionMenu sheet label="列表操作">{close => <>
        <button disabled={!visibleTracks.length} onClick={() => { close(); selection.enter() }}>多选歌曲</button>
        <button disabled={!visibleTracks.length} onClick={() => { close(); enqueue(visibleTracks) }}><ListPlus size={16}/>全部加入队列</button>
      </>}</ActionMenu>}
    </div></div>}
    {duplicates.count > 0 && <button type="button" className="collection-flat-button playlist-duplicate-notice" disabled={organizer.editing} onClick={() => duplicates.setOpen(true)}>可能重复 · 查看 {duplicates.count} 组</button>}

    {filter.trim() && !visibleTracks.length && Boolean(tracks.data?.length) && <p className="collection-empty">没有匹配的音乐</p>}
    {favoriteError && <p className="inline-error">{favoriteError}</p>}
    {deleteNotice && createPortal(<button type="button" className="library-toast" role="status" onClick={() => setDeleteNotice('')}>{deleteNotice}</button>, document.body)}
    {organizer.error && <p className="inline-error" role="alert">{organizer.error}</p>}
    <div>
    {loadingTracks && <ListSkeleton label="正在读取歌曲" />}
    {tracks.isError && <LibraryEmpty title="资料库读取失败" detail={commandErrorMessage(tracks.error)} />}
    {trackRows?.length === 0 && <LibraryEmpty title={isFavorites ? '还没有喜欢的歌曲' : playlist ? '歌单还是空的' : recent ? '还没有播放记录' : '还没有收藏的歌曲'} detail={isFavorites ? '点击歌曲旁的红心，或通过“加入歌单”添加到我喜欢。' : playlist ? '通过歌曲菜单把歌曲加入这里。' : recent ? '播放过的歌曲会出现在这里。' : '点击红心，或把歌曲加入歌单后，它会出现在这里。'} />}
    {Boolean(trackRows?.length) && <div className="library-grid" ref={grid} {...organizer.listProps}>{rendered.rows.map((source, index) => { const track = favoriteOverrides[source.id] === undefined ? source : { ...source, liked: favoriteOverrides[source.id] }; const unavailable = offlineUnavailable(track, offline); const entry=imported.byTrack.get(track.id); const originalSong=track.titleOverridden?undefined:entry?.song; const rowActions=editable?{replaceVideo:()=>entry ? setReplacement(entry) : setReplaceTrack(track)}:undefined; return <article className={selection.selecting ? 'library-track selecting' : 'library-track playing-row'} {...organizer.rowProps(track.id)} data-offline-unavailable={unavailable || undefined} data-import-entry={entry?.entryId} data-current-row={currentId === track.id ? track.id : undefined} key={track.id} onDoubleClick={(event) => { if (selection.selecting || unavailable || (event.target as Element).closest('button, a, input, label, [role="button"]')) return; void play(visibleTracks, track.id) }} onContextMenu={(event) => { if (!selection.selecting && !organizer.editing) showTrackMenu(event, track, playlist?.id, visibleTracks, rowActions) }}>
      {selection.selecting ? <label className="library-art-select"><input className="track-select" type="checkbox" aria-label={`选择 ${track.title}`} checked={selection.ids.has(track.id)} onChange={() => selection.toggle(track.id)} /><span className="library-art">{originalSong?.coverUrl || track.coverUrl ? <Artwork variant="thumbnail" src={originalSong?.coverUrl || track.coverUrl} adaptAspect /> : <span className={`tone-${index % 4}`} />}</span></label> :
      <button className="library-art" disabled={unavailable} onClick={() => void play(visibleTracks, track.id)} aria-label={`播放 ${track.title}`}>
        {originalSong?.coverUrl || track.coverUrl ? <Artwork variant="thumbnail" src={originalSong?.coverUrl || track.coverUrl} adaptAspect /> : <span className={`tone-${index % 4}`} />}
        <i><Play fill="currentColor" /></i>
        {currentId === track.id && <PlayingMark/>}
      </button>}
      <div className="library-copy" data-playback-space-pointer={!selection.selecting && !unavailable || undefined} role={selection.selecting ? undefined : 'button'} aria-current={currentId === track.id ? 'true' : undefined} aria-disabled={!selection.selecting && unavailable || undefined} tabIndex={selection.selecting || unavailable ? undefined : 0} onClick={() => { if (selection.selecting) selection.toggle(track.id); else if (!unavailable) void play(visibleTracks, track.id) }} onKeyDown={event => { if (!unavailable && !selection.selecting && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void play(visibleTracks, track.id) } }}><strong>{playlistTrackTitle(track, entry?.song)}</strong><small>{originalSong ? originalSong.artists.join(' / ') || '歌手未知' : trackSubtitle(track)}{originalSong?.album || track.album ? ` · ${originalSong?.album || track.album}` : ''}</small></div>
      <span className="library-duration">{formatTrackDuration(track.durationSeconds)}</span>
      {!selection.selecting && <div className="library-track-actions">
      <button className={track.liked ? 'icon-action liked' : 'icon-action'} aria-busy={favoritePending.has(track.id)} onClick={() => void toggleFavorite(track)} aria-label={track.liked ? '取消喜欢' : '添加喜欢'}><Heart size={17} fill={track.liked ? 'currentColor' : 'none'} /></button>
      {organizer.handle(track.id, 'icon-action') ?? <TrackMenuButton track={track} playlistId={playlist?.id} tracks={visibleTracks} actions={rowActions}/>}
      </div>}
    </article>})}{rendered.manualMore ? <div className="library-load-more" ref={rendered.tail}><button type="button" className="collection-flat-button" onClick={rendered.manualMore}>加载更多</button></div> : rendered.more && <div ref={rendered.tail} className="list-render-tail" aria-hidden="true"/>}</div>}
    </div>
    {active && playlist && <ListBackToTop key={playlist.id}/>}
    {replacement&&imported.data&&<ReplacementDialog entry={replacement} session={imported.data.session} currentTrack={tracks.data?.find(t=>t.id===replacement.trackId)} onSaved={replaced} onClose={()=>setReplacement(undefined)}/>}
    {replaceTrack && playlist && <ReplacementDialog playlistId={playlist.id} currentTrack={replaceTrack} onSaved={() => { setReplaceTrack(undefined); void refresh() }} onClose={() => setReplaceTrack(undefined)}/>}
    {duplicates.open && active && playlist && <PlaylistDuplicateReview playlistId={playlist.id}
      hidden={lyricsPresent} onPreviewLyrics={onPreviewLyrics} onClose={() => duplicates.setOpen(false)}
      onRemoved={() => { duplicates.clear(); void refresh() }}/>}
    {historyDelete && active && !playlist && <HistoryDeleteDialog tracks={historyDelete}
      onClose={() => setHistoryDelete(undefined)}
      onDeleted={() => {
        setHistoryDelete(undefined)
        selection.exit()
        setDeleteNotice(`已删除 ${historyDelete.length} 首歌曲的播放记录`)
        void refresh()
      }}/>}

  </section>
}

function LibraryEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="library-empty"><span><Library /></span><h3>{title}</h3><p>{detail}</p></div>
}


export { MetadataDialog } from './MetadataDialog'
export { PlaylistPicker } from './PlaylistPicker'
