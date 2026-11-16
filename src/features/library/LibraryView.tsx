import { trackSubtitle } from '../../domain/sourceTitle'
import { accountQueryKey } from '../../services/queryKeys'
import { useQuery,useQueryClient } from '@tanstack/react-query'
import { Heart,Library,ListPlus,Play } from 'lucide-react'
import { useEffect,useRef,useState } from 'react'
import type { Track } from '../../domain/track'
import { commandErrorMessage, FAVORITES_PLAYLIST_ID, listLibraryTracks, listPlaylistTracks, listRecentTracks, removeTracksFromPlaylist, toggleStoredFavorite } from '../../services/desktopApi'
import type { Playlist } from '../../domain/library'
import { sortTracks } from '../../services/listOrdering'
import { playlistEntity } from '../../services/listPreferences'
import { hydrateSourceTitles } from '../../services/sourceTitles'
import { hydrateVisibleTracks } from '../../services/sync'
import { ActionMenu } from '../../shared/ActionMenu'
import { Artwork } from '../../shared/Artwork'
import { ListSearch,matchesTrackSearch } from '../../shared/ListSearch'
import { ListSort,useListSort } from '../../shared/ListSort'
import { PlayingMark } from '../../shared/PlayingMark'
import { SegmentedTabs,type TabOption } from '../../shared/SegmentedTabs'
import { formatDuration } from '../../shared/time'
import { useCompactLayout } from '../../shared/useCompactLayout'
import { useLocateCurrentRow } from '../../shared/useLocateCurrentRow'
import { useSwipeTabs } from '../../shared/useSwipeTabs'
import { DownloadsView } from '../downloads/DownloadsView'
import { usePlayerStore } from '../player/playerStore'
import { PlaylistMenu } from './PlaylistEntry'
import { showTrackMenu } from './trackActionStore'
import { TrackMenuButton } from './TrackMenuButton'
import { BatchTrackActions,useTrackSelection } from './useTrackSelection'

export type LibraryTab = 'saved' | 'recent' | 'downloads'
export function MusicLibraryView({ tab, onTabChange }: { tab: LibraryTab; onTabChange: (tab: LibraryTab) => void }) {
  const tabs: TabOption<LibraryTab>[] = [{ id: 'saved', label: '已收藏' }, { id: 'recent', label: '最近播放' }, { id: 'downloads', label: '下载' }]
  const swipe = useSwipeTabs(tabs.map(option => option.id), tab, onTabChange)
  return <div className="music-library">
    <SegmentedTabs tabs={tabs} value={tab} onChange={onTabChange} idPrefix="library-tab" panelId="music-library-panel" label="音乐库视图" className="library-tabs"/>
    <div id="music-library-panel" ref={swipe} data-swipe-tabs role="tabpanel" aria-labelledby={`library-tab-${tab}`}>
      <div className="segmented-panel" key={tab}>{tab === 'downloads' ? <DownloadsView/> : <LibraryView recent={tab === 'recent'}/>}</div>
    </div>
  </div>
}

export function LibraryView({ recent = false, playlist, onPlaylistDeleted, onRematchImported }: { recent?: boolean; playlist?: Playlist; onPlaylistDeleted?: () => void; onRematchImported?:(playlist:Playlist)=>void }) {
  const client = useQueryClient()
  const compact = useCompactLayout()
  const play = usePlayerStore((state) => state.playFromList)
  const playAll = usePlayerStore((state) => state.playAll)
  const enqueue = usePlayerStore((state) => state.enqueue)
  const updatePlayerTrack = usePlayerStore((state) => state.updateTrack)
  const tracks = useQuery({ queryKey: accountQueryKey('library', recent ? 'recent' : 'saved', playlist?.id), queryFn: () => playlist ? listPlaylistTracks(playlist.id) : recent ? listRecentTracks() : listLibraryTracks(false, true) })
  useEffect(() => { if (tracks.data?.length) void hydrateSourceTitles(tracks.data.map(track => track.id), client) }, [tracks.data, client])
  const currentId = usePlayerStore(state => state.current?.id)
  const grid = useRef<HTMLDivElement>(null)
  useLocateCurrentRow(grid, Boolean(playlist), tracks.data?.some(track => track.id === currentId) ? currentId : undefined)
  const [filter, setFilter] = useState('')
  const sortEntity=playlist?playlistEntity(playlist):'view:saved'
  const listSort=useListSort(sortEntity)
  const sortedTracks=sortTracks(tracks.data||[],recent?'source:asc':listSort.rule,listSort.dates,listSort.playCounts)
  const visibleTracks = sortedTracks.filter(track => matchesTrackSearch(track, filter))
  const selection = useTrackSelection(visibleTracks)
  useEffect(() => { setFilter(''); selection.exit() }, [playlist?.id, recent])
  const [favoriteError, setFavoriteError] = useState('')
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, boolean>>({})
  const [favoritePending, setFavoritePending] = useState<Set<string>>(() => new Set())
  useEffect(() => { void hydrateVisibleTracks(tracks.data, client).catch(() => undefined) }, [tracks.data, client])
  const isFavorites = playlist?.id === FAVORITES_PLAYLIST_ID
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: accountQueryKey('library') }), client.invalidateQueries({ queryKey: accountQueryKey('playlists') }), client.invalidateQueries({ queryKey: accountQueryKey('home-recent') })])
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

    {selection.selecting ? <BatchTrackActions selection={selection} total={visibleTracks.length} onRemove={playlist ? async selected => {
      await removeTracksFromPlaylist(playlist.id, selected.map(track => track.id))
      if (isFavorites) selected.forEach(track => updatePlayerTrack({ ...track, liked: false }))
      await refresh()
    } : undefined} /> : <div className={`library-list-toolbar${compact ? ' library-list-toolbar-compact' : ''}`}><div className="collection-actions">
      {!compact && <button disabled={!visibleTracks.length} onClick={selection.enter}>多选</button>}
      <button className="collection-primary" disabled={!visibleTracks.length} onClick={() => void playAll(visibleTracks)}><Play size={16}/>{filter.trim() ? '播放搜索结果' : '播放全部'}</button>
      {!compact && <button disabled={!visibleTracks.length} onClick={() => enqueue(visibleTracks)}><ListPlus size={16}/>全部加入队列</button>}
    </div><div className="library-toolbar-icons">
      {!recent && <ListSort entity={sortEntity}/>}
      <ListSearch query={filter} onChange={setFilter} count={visibleTracks.length}/>
      {playlist ? <PlaylistMenu playlist={playlist} onRemoved={onPlaylistDeleted} onRematch={playlist.id.startsWith('import:') && onRematchImported ? () => onRematchImported(playlist) : undefined}
        listActions={compact ? {select: selection.enter, play: () => { void playAll(visibleTracks) }, enqueue: () => enqueue(visibleTracks), disabled: !visibleTracks.length} : undefined}/> : compact && <ActionMenu sheet label="列表操作">{close => <>
        <button disabled={!visibleTracks.length} onClick={() => { close(); selection.enter() }}>多选歌曲</button>
        <button disabled={!visibleTracks.length} onClick={() => { close(); enqueue(visibleTracks) }}><ListPlus size={16}/>全部加入队列</button>
      </>}</ActionMenu>}
    </div></div>}

    {filter.trim() && !visibleTracks.length && Boolean(tracks.data?.length) && <p className="collection-empty">没有匹配的音乐</p>}
    {favoriteError && <p className="inline-error">{favoriteError}</p>}
    <div>
    {tracks.isLoading && <LibraryEmpty spinning title="正在读取资料库" detail="本地数据库正在准备歌曲信息" />}
    {tracks.isError && <LibraryEmpty title="资料库读取失败" detail={commandErrorMessage(tracks.error)} />}
    {tracks.data?.length === 0 && <LibraryEmpty title={isFavorites ? '还没有喜欢的歌曲' : playlist ? '歌单还是空的' : recent ? '还没有播放记录' : '还没有收藏的歌曲'} detail={isFavorites ? '点击歌曲旁的红心，或通过“加入歌单”添加到我喜欢。' : playlist ? '通过歌曲菜单把歌曲加入这里。' : recent ? '播放过的歌曲会出现在这里。' : '点击红心，或把歌曲加入歌单后，它会出现在这里。'} />}
    {Boolean(tracks.data?.length) && <div className="library-grid" ref={grid}>{visibleTracks.map((source, index) => { const track = favoriteOverrides[source.id] === undefined ? source : { ...source, liked: favoriteOverrides[source.id] }; return <article className={selection.selecting ? 'library-track selecting' : 'library-track playing-row'} data-current-row={currentId === track.id ? track.id : undefined} key={track.id} onContextMenu={(event) => { if (!selection.selecting) showTrackMenu(event, track, playlist?.id, visibleTracks) }}>
      {selection.selecting ? <input className="track-select" type="checkbox" aria-label={`选择 ${track.title}`} checked={selection.ids.has(track.id)} onChange={() => selection.toggle(track.id)} /> :
      <button className="library-art" onClick={() => void play(visibleTracks, track.id)} aria-label={`播放 ${track.title}`}>
        {track.coverUrl ? <Artwork src={track.coverUrl} adaptAspect /> : <span className={`tone-${index % 4}`} />}
        <i><Play fill="currentColor" /></i>
        {currentId === track.id && <PlayingMark/>}
      </button>}
      <div className="library-copy" role="button" aria-current={currentId === track.id ? 'true' : undefined} tabIndex={0} onClick={() => { if (!selection.selecting) void play(visibleTracks, track.id) }} onKeyDown={event => { if (!selection.selecting && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void play(visibleTracks, track.id) } }}><strong>{track.displayTitle || track.title}</strong><small>{trackSubtitle(track)}{track.album ? ` · ${track.album}` : ''}</small></div>
      <span className="library-duration">{formatDuration(track.durationSeconds)}</span>
      {!selection.selecting && <div className="library-track-actions">
      <button className={track.liked ? 'icon-action liked' : 'icon-action'} aria-busy={favoritePending.has(track.id)} onClick={() => void toggleFavorite(track)} aria-label={track.liked ? '取消喜欢' : '添加喜欢'}><Heart size={17} fill={track.liked ? 'currentColor' : 'none'} /></button>
      <TrackMenuButton track={track} playlistId={playlist?.id} tracks={visibleTracks} />
      </div>}
    </article>})}</div>}
    </div>

  </section>
}

function LibraryEmpty({ title, detail, spinning }: { title: string; detail: string; spinning?: boolean }) {
  return <div className="library-empty"><span><Library className={spinning ? 'spin' : ''} /></span><h3>{title}</h3><p>{detail}</p></div>
}


export { MetadataDialog } from './MetadataDialog'
export { PlaylistPicker } from './PlaylistPicker'
