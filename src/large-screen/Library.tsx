import { offlineEntries, offlineUnavailable, useOfflinePlayback, waitForOfflineLibrary } from '../features/player/offlinePlayback'
import { LargeBatchMatch } from './BatchMatch'
import { LinkedMatchStatus, LinkedSelectionActions } from '../features/library/LinkedSelectionActions'
import { useLinkedFolderRefresh } from '../features/library/useLinkedFolderRefresh'
import { useTrackSelection } from '../features/library/useTrackSelection'
import { PlaylistPicker } from '../features/library/PlaylistPicker'
import { trackHidden, videoScope } from '../domain/contentVisibility'
import { useManagedVisibilityScope } from '../shared/useManagedVisibilityScope'
import { ensureVisibility, useContentVisibility, useVisibilityRules } from '../services/contentVisibility'
import { VisibilityControls } from '../shared/VisibilityControls'
import { matchesTrackSearch } from '../shared/ListSearch'
import { trackSubtitle } from '../domain/sourceTitle'
import { accountKeyAt, accountQueryKey } from '../services/queryKeys'
import { prepareListPlayback } from '../features/player/listPlayback'
import { resolveSeasonEntry, playbackIntent } from '../features/player/playerStore'
import { ListSort, useListSort } from '../shared/ListSort'
import { CoverBadge } from '../shared/CoverBadge'
import { loadCollectionMetadata } from './collectionMetadata'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { ArrowLeft, Check, ChevronRight, Folder, Heart, History, Link2, ListChecks, MoreHorizontal, Palette, Play, RefreshCw, ScanSearch, Search, UserRound, X } from 'lucide-react'
import type { Track } from '../domain/track'
import { DownloadListButton, type LinkedTrackActions } from './TrackActions'
import { playlistContext, collectionContext } from './playbackContext'
import { Artwork } from '../shared/Artwork'
import { CreatorFolderArtwork } from '../features/collections/CreatorFolderArtwork'
import { CreatorFolderStyleEditor, creatorFolderStyleTitle } from '../features/collections/CreatorFolderStyleEditor'
import { formatDuration, formatTrackDuration } from '../shared/time'
import { CoverCount } from '../shared/CoverCount'
import { formatPlayCount } from '../shared/count'
import { PublishedDate } from '../shared/PublishedDate'
import { VideoAccessBadge } from '../shared/VideoAccessBadge'
import { hydrateSourceTitles } from '../features/player/sourceTitles'
import { useSeasonCover } from '../shared/useSeasonCover'
import { useVisibleVideoPages } from '../shared/useVisibleVideoPages'
import { isVideoSearchInput, type BiliSearchItem } from '../domain/bilibili'
import { FAVORITES_PLAYLIST_ID, getVideoParts, listPlaylists, listPlaylistTracks, getLinkedFolder, changeLinkedVideo, searchBilibili, listSearchHistory, commandErrorMessage, reorderPlaylist } from '../services/desktopApi'
import type { Playlist } from '../domain/library'
import type { LinkedFolder } from '../domain/bilibili'
import { listCollections, type Collection, type CollectionProgress, type Collections } from '../services/collections'
import { createCollectionResume, isCurrentCollectionResume, resolveCreatorContinuation, resumeCreatorUploads, type CollectionResumeRequest } from '../features/collections/creatorContinuation'
import { useCollectionProgress, useCollectionResumeRequest } from '../features/collections/useCollectionProgress'
import { accountEpoch } from '../services/accountScope'
import { toTrack } from '../services/collectionTrack'
import { getSeason, parseSeasonReference, seasonTracks, seasonCollection, creatorVideoRow, favoriteVideoTrack } from '../services/mediaSources'
import { filterSeasonSection,seasonResumeSelection } from '../domain/seasonSections'
import { SeasonSections,useSeasonSection } from '../shared/SeasonSections'
import { hydrateVisibleTracks } from '../features/sync/librarySync'
import { useListPreferences, playlistEntity } from '../services/listPreferences'
import { playlistTrackTitle, rankList, sortPlaylistTracks, sortTracks } from '../services/listOrdering'
import { ListBackToTop } from '../shared/ListBackToTop'
import { useOrganizer, type Organizer } from '../shared/useOrganizer'
import { linkedFolderKey } from '../services/linkedFolders'
import { openBiliVerification } from '../services/biliRequestStatus'
import { applyLinkedTrackOverrides, useLinkedMatchedCovers } from '../services/linkedMatchedCovers'
import { usePlayerStore, type QueueSource } from '../features/player/playerStore'
import { useImportedPlaylist } from '../features/library/useImportedPlaylist'
import { ReplacementSearch } from '../features/library/ReplacementDialog'
import { PlaylistDuplicateReview, usePlaylistDuplicateNotice } from '../features/library/PlaylistDuplicates'
import { ImportedPlaylistCompletionContent } from '../features/library/ImportedPlaylistCompletion'
import { LargeDialog } from './LargeDialog'
import { LargeLibraryImport } from './LibraryImport'
import { ExploreLanding } from '../features/search/ExploreLanding'
import { dismissLargeKeyboard } from './keyboard'
import { useVideoEntry } from './useVideoEntry'
import type { ImportedEntry, ImportedEntriesSnapshot } from '../domain/importedEntry'

export type LibraryTab = 'playlists' | 'collections' | 'creators'
export type Route = { kind: 'home' | 'library' | 'search' | 'offline' | 'settings' | 'recommendations' | 'bili-feed' } | { kind: 'player'; previewFrom?: Playlist } | { kind: 'playlist'; playlist: Playlist } | { kind: 'folder'; id: string; title: string; scope: LibraryTab } | { kind: 'collection'; item: Collection; resume?: CollectionResumeRequest; parentRef?: string } | { kind: 'creator'; item: Collection; tab?: 'videos' | 'seasons'; query?: string }
export type Navigate = (route: Route) => void
type FilterState = [string, (value: string) => void]
function useFilter(controlled?: FilterState): FilterState { const local = useState(''); return controlled || local }

export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  return error ? <div className="large-error" role="alert"><span>{commandErrorMessage(error)}</span>{retry && <button onClick={retry}><RefreshCw size={20}/>重试</button>}</div> : null
}
export function Empty({ children }: { children: ReactNode }) { return <div className="large-empty"><Search size={34}/><p>{children}</p></div> }
export function Card({ title, subtitle, cover: givenCover, onClick, id, linked, folder, creator, creatorFolder, count, elementRef, playlist, videoBvid, seasonReference, pending, row = false }: { seasonReference?: string; videoBvid?: string; elementRef?: React.Ref<HTMLButtonElement>; playlist?: boolean; title: string; subtitle?: string; cover?: string; onClick: () => void; id: string; linked?: boolean; folder?: boolean; creator?: boolean; creatorFolder?: string; count?: number; pending?: boolean; row?: boolean }) {
  const { ref: seasonCoverRef, cover } = useSeasonCover(seasonReference, givenCover)
  const [aspect, setAspect] = useState<{ cover?: string; ratio: number }>()
  const ratio = aspect && aspect.cover === cover ? aspect.ratio : 16 / 9
  const { ref, pages, access } = useVisibleVideoPages<HTMLSpanElement>(videoBvid ?? '', Boolean(videoBvid), true)
  const copy = <><strong>{title}</strong>{(subtitle || pending) && <small>{pending ? '正在读取…' : subtitle}</small>}</>
  return <button type="button" style={{ '--large-card-ratio': ratio } as React.CSSProperties} className={`large-card${creator ? ' large-creator' : folder ? ' large-folder' : ''}${playlist ? ' large-playlist-card' : ''}${row ? ' large-catalog-row' : ''}`} ref={elementRef} data-focus={id} aria-busy={pending || undefined} onClick={onClick}>
    <span className="large-card-art" ref={ref}>{creatorFolder ? <CreatorFolderArtwork id={creatorFolder}/> : <Artwork elementRef={seasonCoverRef} adaptAspect={!creator} onAspectRatio={ratio => setAspect({ cover, ratio })} src={cover} fallback={folder ? <Folder/> : creator ? <UserRound/> : title === '我喜欢' ? <Heart/> : undefined}/>}{seasonReference ? <CoverCount count={count} unit="个视频" single/> : <CoverCount count={pages?.length}/>}
      {(linked || folder && !creatorFolder) && <CoverBadge kind={linked ? 'linked' : 'folder'}/>}<VideoAccessBadge access={access} onCover/></span>
    {row ? <><span className="large-catalog-copy">{copy}</span><ChevronRight size={20} aria-hidden="true"/></> : copy}
  </button>
}
function CollectionCard({ item, navigate, opener }: { item: Collection; navigate: Navigate; opener: ReturnType<typeof useVideoEntry> }) {
  const ref = useRef<HTMLButtonElement>(null), client = useQueryClient(), epoch = accountEpoch()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '120px' })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  const metadata = useQuery({ queryKey: accountKeyAt(epoch, 'large-collection-metadata', item.bvid), queryFn: () => loadCollectionMetadata(item, epoch), enabled: visible && (!item.title || !item.coverUrl || item.coverUrl.includes("viedeo_material_default") || item.title === item.bvid), staleTime: 300000, retry: false })
  useEffect(() => {
    if (!metadata.data || epoch !== accountEpoch()) return
    client.setQueryData<Collections>(accountQueryKey('collections'), old => old ? { ...old, items: old.items.map(i => i.bvid === item.bvid ? { ...i, title: metadata.data!.title, coverUrl: metadata.data!.coverUrl, uploaderName: metadata.data!.uploaderName } : i) } : old)
  }, [metadata.data, client, epoch, item.bvid])
  const display = metadata.data ? { ...item, title: metadata.data.title, coverUrl: metadata.data.coverUrl, uploaderName: metadata.data.uploaderName } : item
  const creator = item.bvid.startsWith('up:')
  const season = parseSeasonReference(item.bvid)
  const count = season ? client.getQueryData<{ videoCount?: number }>(accountQueryKey('large-collection', item.bvid))?.videoCount : undefined
  return <Card elementRef={ref} id={`collection-${item.bvid}`} creator={creator}
    seasonReference={season ? item.bvid : undefined} count={count} videoBvid={creator || season ? undefined : item.bvid}
    title={item.note || display.title || (creator ? `UP 主 ${item.bvid.slice(3)}` : '正在读取合集…')}
    subtitle={item.note ? display.title : creator ? undefined : display.uploaderName} cover={display.coverUrl} pending={opener.pending === item.bvid}
    onClick={() => creator ? navigate({ kind: 'creator', item: display }) : season ? navigate({ kind: 'collection', item: display }) : void opener.open(display)}/>
}
export function LargeLibrary({ tab, setTab, navigate, folder, filterState }: { filterState?: FilterState; tab: LibraryTab; setTab: (tab: LibraryTab) => void; navigate: Navigate; folder?: Extract<Route, { kind: 'folder' }> }) {
  const playlists = useQuery({ queryKey: accountQueryKey('playlists'), queryFn: listPlaylists })
  const collections = useQuery({ queryKey: accountQueryKey('collections'), queryFn: listCollections })
  const prefs = useListPreferences(), preferences = prefs.data?.preferences || []
  const [filter, setFilter] = useFilter(filterState)
  const [importNotice, setImportNotice] = useState('')
  const [editingFolderIcon, setEditingFolderIcon] = useState(false)
  const scope = folder?.scope || tab
  const opener = useVideoEntry(navigate, folder?.id || tab)
  const matches = (text: string) => text.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())
  const items = collections.data?.items.filter(i => i.bvid.startsWith('up:') === (scope === 'creators') && (!folder ? !i.folderId : i.folderId === folder.id)) || []
  const folders = folder ? [] : (collections.data?.folders || []).filter(f => (f.scope === 'creators') === (scope === 'creators'))
  const error = scope === 'playlists' ? playlists.error : collections.error
  return <>
    {folder && <header className="large-page-heading"><h1>{folder.title}</h1>{scope === 'creators' && <div className="large-toolbar">
      <button type="button" onClick={() => setEditingFolderIcon(true)}><Palette/>{creatorFolderStyleTitle}</button>
    </div>}</header>}
    {folder && scope === 'creators' && editingFolderIcon && <LargeDialog title={creatorFolderStyleTitle} className="creator-folder-style-dialog" onClose={() => setEditingFolderIcon(false)}>
      <CreatorFolderStyleEditor id={folder.id} name={folder.title} onClose={() => setEditingFolderIcon(false)}/>
    </LargeDialog>}
    {!folder && <div className="large-tabs" role="tablist" aria-label="音乐库分类">{(['playlists', 'collections', 'creators'] as const).map((t, i) => <button role="tab" aria-selected={tab === t} key={t} data-focus={`library-${t}`} onClick={() => { setFilter(''); setImportNotice(''); setTab(t) }}>{['歌单', '收藏', '关注'][i]}</button>)}</div>}
    <div className="large-library-tools">
      <ListFilter value={filter} onChange={setFilter} label={scope === 'creators' ? '查找关注的 UP 主' : '查找音乐库'}/>
      {!folder && <LargeLibraryImport key={scope} scope={scope} navigate={navigate} onViewCollections={() => setFilter('')} onImported={setImportNotice}/>}
    </div>
    {importNotice && <p className="large-library-import-notice" role="status">{importNotice}</p>}
    <Failure error={error} retry={() => { void playlists.refetch(); void collections.refetch() }}/>
    <Failure error={opener.error}/>
    <div className="large-grid">
      {scope === 'playlists' ? rankList(playlists.data || [], preferences, playlistEntity).filter(p => matches(p.name)).map(p => <Card playlist key={p.id} id={`playlist-${p.id}`} title={p.name} subtitle={`${p.trackCount} ${p.biliFolderId ? '个视频' : '首'}`} cover={p.coverUrl} linked={Boolean(p.biliFolderId)} onClick={() => navigate({ kind: 'playlist', playlist: p })}/>) : <>
        {rankList(folders, preferences, f => `${scope === 'creators' ? 'creatorFolder' : 'collectionFolder'}:${f.id}`).filter(f => matches(f.name)).map(f => <Card key={f.id} id={`folder-${f.id}`} folder creatorFolder={scope === 'creators' ? f.id : undefined} title={f.name} cover={scope === 'creators' ? undefined : collections.data?.items.find(i => i.folderId === f.id && i.coverUrl)?.coverUrl} onClick={() => navigate({ kind: 'folder', id: f.id, title: f.name, scope })}/>)}
        {rankList(items, preferences, i => `collection:${i.bvid}`).filter(i => matches(i.note || i.title)).map(i => <CollectionCard key={i.bvid} item={i} navigate={navigate} opener={opener}/>)}
      </>}
    </div>
    {!error && !(scope === 'playlists' ? playlists.isPending || playlists.data?.length : collections.isPending || items.length || folders.length) && <Empty>{folder ? '暂无内容' : scope === 'creators' ? '可以从 B 站导入关注的 UP 主' : scope === 'collections' ? '可以从 B 站导入订阅合集' : '可以从 B 站导入收藏夹'}</Empty>}
  </>
}

export function ListFilter({ value, onChange, label = '搜索列表中的音乐' }: { value: string; onChange: (value: string) => void; label?: string }) {
  return <label className="large-search"><Search size={22}/><input data-primary-focus aria-label={label} placeholder={label} value={value} onChange={e => onChange(e.target.value)}/>{value && <button aria-label="清空搜索" onClick={() => onChange('')}><X size={20}/></button>}</label>
}
function TrackRowArt({ track, cover, videoEntry }: { track: Track; cover?: string; videoEntry: boolean }) {
  const { ref, pages } = useVisibleVideoPages<HTMLSpanElement>(track.source.bvid, videoEntry && !track.partCount && !track.sourceExpired)
  return <span className="large-track-art" ref={ref}><Artwork variant="thumbnail" adaptAspect src={cover}/>
    {videoEntry && <CoverCount count={track.partCount ?? pages?.length}/>}</span>
}

export function TrackRows({ tracks, source, onMore, onPlayed, onOpen, pendingVideo, visibilityScope,playbackTracks=tracks,importedEntries,organizer }: { organizer?: Organizer; importedEntries?:ImportedEntry[];visibilityScope?:string;playbackTracks?:Track[];tracks: Track[]; source?: QueueSource; onMore: (track: Track) => void; onPlayed?: () => void; onOpen?: (track: Track) => void; pendingVideo?: string }) {
  const rules=useVisibilityRules()
  const id = usePlayerStore(s => s.current?.id), status = usePlayerStore(s => s.status)
  const offline = useOfflinePlayback()
  const origins=new Map(importedEntries?.filter(e=>e.trackId).map(e=>[e.trackId,e.song]))
  return <div className="large-tracks" {...organizer?.listProps}>{tracks.map((track, index) => {const unavailable = offlineUnavailable(track, offline) || !offline.offline && track.sourceExpired; const origin=track.titleOverridden?undefined:origins.get(track.id);return <div {...organizer?.rowProps(track.id)} data-offline-unavailable={unavailable || undefined} className={`large-track${track.id === id ? ' current' : ''}${visibilityScope&&trackHidden(track,visibilityScope,rules)?' visibility-hidden':''}`} key={track.id}>
    <button disabled={unavailable || Boolean(visibilityScope&&trackHidden(track,visibilityScope,rules))} className="large-track-main" data-focus={`track-${track.id}`} aria-busy={pendingVideo === track.source.bvid || undefined} onClick={() => { if (onOpen && !offline.offline) onOpen(track); else { void usePlayerStore.getState().playFromList(playbackTracks, track.id, source); onPlayed?.() } }}>
      <span className="large-track-number">{track.id === id && status === 'playing' ? <span className="large-playing-mark">ııı</span> : index + 1}</span><TrackRowArt track={track} cover={origin?.coverUrl || track.coverUrl} videoEntry={Boolean(onOpen) && !offline.offline}/><span className="large-track-copy"><strong>{playlistTrackTitle(track, origin)}</strong><small>{pendingVideo === track.source.bvid ? '正在读取…' : track.sourceExpired ? '已失效' : origin ? origin.artists.join(' / ') || '歌手未知' : trackSubtitle(track,source)}<PublishedDate value={track.publishedAt}/></small></span><span className="large-track-duration">{formatTrackDuration(track.durationSeconds)}</span>
    </button>{organizer?.handle(track.id, "large-icon large-track-more") ?? <button className="large-icon large-track-more" data-focus={`more-${track.id}`} aria-label={`${track.title}的更多操作`} onClick={() => onMore(track)}><MoreHorizontal/></button>}
  </div>})}</div>
}

export function LargePlaylist({ playlist, onMore, navigate, filterState, previewing }: { previewing?: boolean; filterState?: FilterState; playlist: Playlist; onMore: (t: Track,replaceVideo?:()=>void,linked?:LinkedTrackActions) => void; navigate: Navigate }) {
  const client = useQueryClient(), prefs = useListPreferences()
  const linked = playlist.biliFolderId
  const imported=useImportedPlaylist(playlist)
  const [replacement,setReplacement]=useState<ImportedEntry>(),[completion,setCompletion]=useState(false),[matching,setMatching]=useState(false)
  const [replaceTrack,setReplaceTrack]=useState<Track>()
  const [removing, setRemoving] = useState<Track>(), [removeBusy, setRemoveBusy] = useState(false)
  const opener = useVideoEntry(navigate, playlist.id)
  const linkedItem = (track: Track): Collection => ({
    bvid: track.source.bvid, folderId: '', title: track.videoTitle || track.title, coverUrl: track.coverUrl || '', uploaderName: track.source.uploaderName || '',
  })
  const openLinkedVideo = (track: Track) => navigate({ kind: 'collection', item: linkedItem(track) })
  const removeLinked = async () => {
    if (!linked || !removing || removeBusy) return
    const epoch = accountEpoch()
    setRemoveBusy(true); setOpenerError(undefined)
    try {
      const folder = await changeLinkedVideo(linked, removing.source.bvid, false)
      if (epoch !== accountEpoch()) return
      client.setQueryData(linkedFolderKey(linked), folder)
      void client.invalidateQueries({queryKey: accountQueryKey('playlists')})
      setRemoving(undefined)
    } catch (cause) { if (epoch === accountEpoch()) setOpenerError(cause) }
    finally { setRemoveBusy(false) }
  }
  const query = useQuery<Track[] | LinkedFolder | null>({ queryKey: linked ? linkedFolderKey(linked) : accountQueryKey('library', playlist.id), queryFn: () => linked ? getLinkedFolder(linked) : listPlaylistTracks(playlist.id) })
  const [filter, setFilter] = useFilter(filterState), [openerError, setOpenerError] = useState<unknown>()
  const offline = useOfflinePlayback()
  const refresh = useLinkedFolderRefresh(linked, query.isPending, offline.offline)
  const regularPlaylist = Array.isArray(query.data)
  const refreshedAt = regularPlaylist ? undefined : (query.data as LinkedFolder | null | undefined)?.refreshedAt
  const verify = async () => {
    const epoch = accountEpoch()
    setOpenerError(undefined)
    try { await openBiliVerification() }
    catch (error) { if (epoch === accountEpoch()) setOpenerError(error) }
  }
  const videos = Array.isArray(query.data) ? undefined : query.data?.videos
  const videoIds = useMemo(() => videos?.map(video => video.bvid) ?? [], [videos])
  const { byVideo } = useLinkedMatchedCovers(videoIds)
  const raw = Array.isArray(query.data) ? query.data : videos?.map(video => {
    return applyLinkedTrackOverrides(favoriteVideoTrack(video), byVideo.get(video.bvid))
  }) ?? []
  useEffect(() => {
    if (linked || offline.offline || !Array.isArray(query.data)) return
    void hydrateVisibleTracks(query.data, client).catch(() => undefined)
    const unknownDurations = query.data.filter(track => !track.durationSeconds)
    if (unknownDurations.length) void hydrateSourceTitles(unknownDurations.map(track => track.id), client).catch(() => undefined)
  }, [query.data, linked, client, offline.offline])
  const entity = playlistEntity(playlist), rule = prefs.data?.preferences.find(p => p.entity === entity)?.sortRule || 'source:asc'
  const dates = prefs.data?.dates || {}, playCounts = prefs.data?.playCounts || {}
  const editable = !linked && (!playlist.isSystem || playlist.id === FAVORITES_PLAYLIST_ID)
  const reorderable = editable && !playlist.id.startsWith('import:')
  const tracks = (linked ? sortTracks(raw, rule, dates, playCounts) : sortPlaylistTracks(raw, rule, dates, playCounts, imported.byTrack, reorderable)).filter(t => {const entry=imported.byTrack.get(t.id);return matchesTrackSearch(t,filter)||Boolean(entry&&`${entry.song.title} ${entry.song.artists.join(' ')} ${entry.song.album||''}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))})
  const organizer = useOrganizer(reorderable && !filter.trim() ? tracks.map(track => ({ id: track.id, name: playlistTrackTitle(track) })) : [], '整理曲目', {
    expected: raw.map(track => track.id),
    saveOrder: async (expected, ordered) => {
      const epoch = accountEpoch()
      await reorderPlaylist(playlist.id, expected, ordered)
      if (epoch !== accountEpoch()) return
      await Promise.all(['library', 'playlists', 'list-preferences'].map(key => client.invalidateQueries({queryKey: accountQueryKey(key)})))
    },
  })
  const duplicates = usePlaylistDuplicateNotice(editable ? playlist.id : undefined, raw)
  useEffect(() => { organizer.cancel(); setReplaceTrack(undefined) }, [playlist.id])
  const source = playlistContext(playlist.name, Boolean(linked))
  const selection = useTrackSelection(tracks)
  const [addingSelected, setAddingSelected] = useState<Track[]>([])
  const replaced=(snapshot:ImportedEntriesSnapshot)=>{
    const epoch=accountEpoch(),trackId=snapshot.entries.find(e=>e.entryId===replacement?.entryId)?.trackId
    client.setQueryData(accountQueryKey('imported-entries',playlist.id),snapshot);setReplacement(undefined)
    void query.refetch().then(()=>requestAnimationFrame(()=>{if(epoch!==accountEpoch())return;[...document.querySelectorAll<HTMLElement>('[data-focus]')].find(el=>el.dataset.focus===`more-${trackId}`)?.focus({preventScroll:true})}))
    void client.invalidateQueries({queryKey:accountQueryKey('playlists')})
  }
  return <><header className="large-page-heading"><div><h1>{playlist.name}{linked && <Link2 size={22}/>}</h1><p>{raw.length} {linked ? '个视频 · B站关联收藏夹' : '首歌曲'}</p></div><div className="large-toolbar">{reorderable && organizer.controls}<ListSort entity={entity} customOrder={reorderable} disabled={organizer.editing}/>{!selection.selecting && <>
    {linked ? <button disabled={!tracks.length} onClick={selection.enter}><ListChecks/>多选</button> : <button disabled={!tracks.length} onClick={()=>setMatching(true)}>自动匹配</button>}
    {editable && <button disabled={raw.length < 2} title="查找重复" aria-label="查找重复" onClick={() => duplicates.setOpen(true)}><ScanSearch/></button>}
    {linked && !refresh.message && <button type="button" disabled={!refresh.canRetry} onClick={() => void refresh.refresh()}><RefreshCw/>{refresh.refreshing ? '同步中' : '同步'}</button>}
    {imported.missing.length>0&&<button onClick={()=>setCompletion(true)}><RefreshCw/>补全未匹配 · {imported.missing.length}</button>}<DownloadListButton tracks={tracks}/><button className="large-primary" disabled={!tracks.some(track => !offlineUnavailable(track, offline) && (offline.offline || !track.sourceExpired))} onClick={() => void usePlayerStore.getState().playFromList(tracks, tracks[0].id, source)}><Play/>播放全部</button>
  </>}</div></header><ListFilter value={filter} onChange={value => { organizer.cancel(); setFilter(value) }}/>
    {organizer.error && <p className="large-error" role="alert">{organizer.error}</p>}
    {duplicates.count > 0 && <div className="large-toolbar"><button className="playlist-duplicate-notice" onClick={() => duplicates.setOpen(true)}>可能重复 · 查看 {duplicates.count} 组</button></div>}
    {linked && <LinkedMatchStatus folderId={linked} large refreshPause={refresh.pause}/>}
    <Failure error={query.error || openerError || opener.error} retry={query.error ? () => void query.refetch() : undefined}/>
    {linked && refresh.message && <div className="large-error large-linked-refresh-status" role="status">
      <span>{refresh.message}{!refreshedAt && refresh.read > 0 && ` · 已读取 ${refresh.read} 个视频`}</span>
      {refresh.pause?.reason === 'verificationRequired' && <button type="button" onClick={() => void verify()}>前往 B 站</button>}
      <button type="button" disabled={!refresh.canRetry} onClick={() => void refresh.refresh()}><RefreshCw size={20}/>{refresh.paused ? '继续' : '重试'}</button>
    </div>}
    {linked && !refreshedAt && refresh.refreshing && <p className="large-muted" role="status">{refresh.read ? `已读取 ${refresh.read} 个视频` : '正在读取收藏夹…'}</p>}
    {linked && selection.selecting ? <>
      <LinkedSelectionActions folderId={linked} total={tracks.length} selection={selection}
        toolbarClass="large-toolbar large-linked-selection"
        onChoosePlaylist={setAddingSelected}
        onFolderChanged={folder => { client.setQueryData(linkedFolderKey(linked), folder); void client.invalidateQueries({ queryKey: accountQueryKey('playlists') }) }}
        confirmDialog={(body, close) => <LargeDialog title="从 B 站收藏夹移除" onClose={close}>{body}</LargeDialog>}/>
      <div className="large-tracks">{tracks.map(track => <div className="large-track" key={track.id} data-offline-unavailable={offlineUnavailable(track, offline) || undefined}><button type="button"
        className="large-track-main" role="checkbox" data-focus={`track-${track.id}`} aria-checked={selection.ids.has(track.id)} onClick={() => selection.toggle(track.id)}>
        <span className="large-track-number">{selection.ids.has(track.id) ? <Check/> : <span aria-hidden="true">□</span>}</span>
        <span className="large-track-art"><Artwork variant="thumbnail" adaptAspect src={track.coverUrl}/></span><span className="large-track-copy"><strong>{track.title}</strong>{track.sourceExpired && <small>已失效</small>}</span>
        <span className="large-track-duration">{formatTrackDuration(track.durationSeconds)}</span>
      </button></div>)}</div>
    </> : <TrackRows tracks={organizer.order(tracks, track => track.id)} playbackTracks={tracks} organizer={organizer} source={source} importedEntries={imported.entries} onMore={track=>{const entry=imported.byTrack.get(track.id);onMore(track,editable ? () => entry ? setReplacement(entry) : setReplaceTrack(track) : undefined, linked ? {openParts: () => openLinkedVideo(track), remove: () => { setOpenerError(undefined); setRemoving(track) }} : undefined)}} pendingVideo={opener.pending}
      onOpen={linked ? track => void opener.open(linkedItem(track), { row: track, queue: tracks, source, applyOverrides: resolved => applyLinkedTrackOverrides(resolved, byVideo.get(track.source.bvid)) }) : undefined}/>}
    {removing && <LargeDialog title="从 B 站收藏夹移除" onClose={() => { if (!removeBusy) setRemoving(undefined) }}>
      <p>从 B 站收藏夹移除「{removing.title}」及其全部分 P？</p>
      <Failure error={openerError}/>
      <div className="large-options"><button type="button" disabled={removeBusy} onClick={() => setRemoving(undefined)}>取消</button>
        <button type="button" className="action-danger" disabled={removeBusy} onClick={() => void removeLinked()}>确认移除</button></div>
    </LargeDialog>}
    {!query.isPending && !tracks.length && (!linked || refreshedAt) && <Empty>{filter ? '没有匹配的歌曲' : '这个歌单还没有歌曲'}</Empty>}
    {addingSelected.length > 0 && <PlaylistPicker selection={{ items: addingSelected.map(track => ({ kind: 'track', track })) }} onClose={() => setAddingSelected([])}
      renderDialog={(body, close) => <LargeDialog title="收藏到歌单" onClose={close} className="large-linked-picker">{body}</LargeDialog>}/>}
    {!linked && !previewing && <ListBackToTop key={playlist.id}/>}
    {matching&&<LargeBatchMatch tracks={tracks} onMatched={ids => { void duplicates.review(ids).catch(() => undefined) }} onClose={()=>setMatching(false)}/>}
    {replacement&&imported.data&&<LargeDialog title="更换视频" className="import-match-large-dialog" onClose={()=>setReplacement(undefined)}><ReplacementSearch entry={replacement} session={imported.data.session} currentTrack={raw.find(t=>t.id===replacement.trackId)} onSaved={replaced} onClose={()=>setReplacement(undefined)}/></LargeDialog>}
    {replaceTrack && <LargeDialog title="更换视频" className="import-match-large-dialog" onClose={() => setReplaceTrack(undefined)}>
      <ReplacementSearch playlistId={playlist.id} currentTrack={replaceTrack} onSaved={() => { setReplaceTrack(undefined); void query.refetch(); void client.invalidateQueries({queryKey: accountQueryKey('playlists')}) }} onClose={() => setReplaceTrack(undefined)}/>
    </LargeDialog>}
    {duplicates.open && <PlaylistDuplicateReview playlistId={playlist.id} hidden={previewing}
      onPreviewLyrics={() => navigate({ kind: 'player', previewFrom: playlist })} onClose={() => duplicates.setOpen(false)}
      onRemoved={() => { duplicates.clear(); void query.refetch(); void client.invalidateQueries({queryKey: accountQueryKey('playlists')}) }}
      renderDialog={body => <LargeDialog title="查找重复" className="playlist-duplicates-dialog" onClose={() => duplicates.setOpen(false)}>{body}</LargeDialog>}/>}
    {completion&&<LargeDialog title="补全未匹配" className="import-match-large-dialog" onClose={()=>setCompletion(false)}><ImportedPlaylistCompletionContent playlist={playlist} onClose={()=>setCompletion(false)} renderReplacement={props=><LargeDialog title="更换视频" className="import-match-large-dialog" onClose={props.onClose}><ReplacementSearch {...props}/></LargeDialog>}/></LargeDialog>}
  </>
}

export function LargeCollection({ item, onMore, navigate, filterState, resumeRequest, parentRef }: { filterState?: FilterState; item: Collection; onMore: (t: Track,visibilityScope?:string) => void; navigate: Navigate; resumeRequest?: CollectionResumeRequest; parentRef?: string }) {
  const season = parseSeasonReference(item.bvid), [filter, setFilter] = useFilter(filterState)
  const opener = useVideoEntry(navigate, item.bvid)
  const query = useQuery({ queryKey: accountQueryKey('large-collection', item.bvid), queryFn: async () => { if (season) { const data = await getSeason(season.mid, season.seasonId); return { tracks: seasonTracks(data), videoCount: data.tracks.length + data.unavailable, sections:data.sections, access: undefined, season: undefined, title: data.summary.title, uploaderName: data.summary.uploaderName } }; const detail = await getVideoParts(item.bvid); return { tracks: detail.parts.map(p => toTrack(detail, p)), sections:undefined, access: detail.access, season: detail.season, title: detail.title, uploaderName: detail.uploaderName } } })
  const { byPart } = useLinkedMatchedCovers(season ? [] : [item.bvid])
  const collectionTracks = (query.data?.tracks ?? []).map(track => applyLinkedTrackOverrides(track, byPart.get(track.id)))
  const progress = useCollectionProgress(item.bvid, !parentRef)
  const offline = useOfflinePlayback()
  const rules=useVisibilityRules(), [shown,setShown]=useState(false)
  const scope=useManagedVisibilityScope(season?item.bvid:videoScope(item.bvid),query.data?.tracks ?? [],parentRef)
  const queueScope = scope && parentRef?.startsWith('season:') ? parentRef : scope
  const isHidden=(track:Track)=>Boolean(queueScope && trackHidden(track,queueScope,rules))
  const sorting = useListSort(`collection:${item.bvid}`)
  const [selectedSection,setSelectedSection] = useSeasonSection(item.bvid,query.data?.sections)
  const ordered = sortTracks(filterSeasonSection(collectionTracks,query.data?.sections,selectedSection), sorting.rule, sorting.dates, sorting.playCounts)
  const tracks = ordered.filter(t => (shown || !isHidden(t)) && matchesTrackSearch(t,filter))
  const resumeTracks=sortTracks(collectionTracks,sorting.rule,sorting.dates,sorting.playCounts)
  const canPlay = (track: Track) => !isHidden(track) && offlineEntries(track, offline).some(part => !isHidden(part))
  const checkpoint = parentRef ? undefined : progress.data
  const canResume = checkpoint && resumeTracks.some(canPlay) && resumeTracks.some(t => t.source.bvid === checkpoint.bvid && (t.source.cid === checkpoint.cid || t.resolveParts))
  const source = { ...collectionContext(query.data?.title || item.title, item.bvid, Boolean(season), query.data?.tracks.length || 0),
    ...(parentRef && { collectionRef:parentRef }), visibilityManaged: Boolean(queueScope) }
  const [playError, setPlayError] = useState('')
  const playVersion = useRef(0)
  useLayoutEffect(() => { setPlayError(''); return () => { playVersion.current++ } }, [item.bvid])
  const play = async (resume?: CollectionProgress) => {
    const epoch = accountEpoch(), intent = playbackIntent(), version = ++playVersion.current
    const current = () => version === playVersion.current && epoch === accountEpoch() && intent === playbackIntent()
    setPlayError('')
    try {
      if (resume) {
        await ensureVisibility()
        await waitForOfflineLibrary()
      }
      if (!current()) return
      const latestRules = useContentVisibility.getState().rules
      const latestOffline = useOfflinePlayback.getState()
      const prepared = await prepareListPlayback(resume ? resumeTracks : tracks, resume, resolveSeasonEntry, current,
        track => !queueScope || !trackHidden(track, queueScope, latestRules), latestOffline.offline ? track => offlineEntries(track, latestOffline) : undefined)
      if (!current()) return
      if (!prepared) { setPlayError('没有可继续播放的内容。'); return }
      const selection = resume ? seasonResumeSelection(prepared.queue,prepared.sourceTrackId ?? prepared.trackId,query.data?.sections,selectedSection) : {tracks:prepared.queue,sectionId:selectedSection}
      if (resume) { setSelectedSection(selection.sectionId); setFilter('') }
      await usePlayerStore.getState().playFromList(selection.tracks, prepared.trackId, source, prepared.startAt, true)
    } catch (error) { if (current()) setPlayError(commandErrorMessage(error)) }
  }
  useCollectionResumeRequest(resumeRequest, query.isSuccess, play)
  const parentSeason = query.data?.season
  return <>
    <header className="large-page-heading">
      <div><h1>{query.data?.title || item.title || '合集'}</h1><VideoAccessBadge access={query.data?.access}/>
        <p>{query.data?.uploaderName || item.uploaderName} · {(season ? query.data?.videoCount : query.data?.tracks.length) ?? 0} {season ? '集' : 'P'}</p></div>
      <div className="large-toolbar">
        <ListSort entity={`collection:${item.bvid}`}/><DownloadListButton tracks={tracks} visibilityScope={scope}/>
        {canResume && <button type="button" onClick={() => void play(checkpoint)}>继续上次</button>}
        <button type="button" className="large-primary" disabled={!tracks.some(canPlay)} onClick={() => void play()}><Play/>播放全部</button>
      </div>
    </header>
    {parentSeason && <button className="large-text-button" onClick={() => navigate({ kind: 'collection', item: seasonCollection(parentSeason) })}>查看所属合集</button>}
    <SeasonSections sections={query.data?.sections} selected={selectedSection} onChange={setSelectedSection}/>
    {scope && <VisibilityControls scope={scope} rules={rules} shown={shown} onShow={setShown} tracks={query.data?.tracks || []}/>}
    <ListFilter value={filter} onChange={setFilter}/>
    <Failure error={query.error || opener.error || (playError ? new Error(playError) : null)} retry={query.error ? () => void query.refetch() : undefined}/>
    {query.isPending ? <p className="large-muted" role="status">正在读取内容…</p> : <TrackRows visibilityScope={queueScope} tracks={tracks} playbackTracks={ordered} source={source} onMore={track=>onMore(track,scope)}
      pendingVideo={opener.pending} onOpen={season ? track => void opener.open(
        { bvid: track.source.bvid, title: track.videoTitle || track.title, coverUrl: track.coverUrl || '', uploaderName: item.uploaderName, folderId: '' },
        { parentRef: item.bvid, row: track, queue: ordered, source, applyOverrides: resolved => applyLinkedTrackOverrides(resolved, byPart.get(resolved.id)) },
      ) : undefined}/>}
  </>
}


type Creator = { mid: number; uname: string; upic: string; fans?: number }
type Catalog = { page: number; data: { numResults?: number; result?: Creator[]; page?: { count: number }; list?: { vlist: Parameters<typeof creatorVideoRow>[0][] }; items_lists?: { page?: { total: number }; seasons_list?: { meta: { season_id: number; name: string; cover: string; total: number } }[] } } }
const catalog = (action: string, mid: number | undefined, page: number, keyword = '') => invoke<Catalog>('bili_creator_catalog', { action, mid, page, keyword })

export function LargeSearch({ query, setQuery, navigate, kind, setKind, onBack }: {
  kind: 'video' | 'creator'; setKind: (kind: 'video' | 'creator') => void
  query: string; setQuery: (q: string) => void; navigate: Navigate; onBack: () => void
}) {
  const [input, setInput] = useState(query)
  const inputRef = useRef<HTMLInputElement>(null)
  const videoTab = useRef<HTMLButtonElement>(null)
  const focusResults = useRef(false)
  const history = useQuery({ queryKey: accountQueryKey('search-history'), queryFn: listSearchHistory })
  const opener = useVideoEntry(navigate, `${kind}:${query}`)
  const results = useInfiniteQuery({ queryKey: accountQueryKey('large-search', kind, query), initialPageParam: 1, enabled: Boolean(query), queryFn: async ({ pageParam }) => kind === 'video' ? { videos: await searchBilibili(query, pageParam), creators: undefined } : { videos: undefined, creators: await catalog('search', undefined, pageParam, query) }, getNextPageParam: last => last.videos ? last.videos.page * last.videos.pageSize < last.videos.total ? last.videos.page + 1 : undefined : last.creators && last.creators.page * 20 < (last.creators.data.numResults || 0) ? last.creators.page + 1 : undefined })
  useLayoutEffect(() => {
    setInput(query)
    if (!query || !focusResults.current) return
    focusResults.current = false
    videoTab.current?.focus({ preventScroll: true })
  }, [query])
  const submit = (value: string) => {
    const keyword = value.trim()
    if (!keyword || isVideoSearchInput(keyword)) setKind('video')
    setInput(keyword)
    setQuery(keyword)
  }
  const clear = () => {
    submit('')
    inputRef.current?.focus({ preventScroll: true })
  }
  const exploreSearch = (keyword: string) => {
    dismissLargeKeyboard()
    focusResults.current = true
    setKind('video')
    submit(keyword)
  }
  return <>
    <header className="large-explore-top">
      <button type="button" className="large-icon" aria-label="返回上一页" onClick={query ? () => submit('') : onBack}><ArrowLeft/></button>
      {!query && <h1>探索</h1>}
      <form className="large-search" onSubmit={event => { event.preventDefault(); submit(input) }}>
        <Search size={22}/>
        <input ref={inputRef} data-primary-focus data-focus="search-input" value={input} onChange={event => setInput(event.target.value)}
          placeholder="搜索歌曲、歌手或 BV 号" aria-label="搜索歌曲、歌手、BV 号或链接"/>
        {(input || query) && <button type="button" className="large-icon" aria-label="清空搜索" onClick={clear}><X size={19}/></button>}
        <button className="large-primary" type="submit">搜索</button>
      </form>
    </header>
    <ExploreLanding active={!query} history={history.data ?? []} onSearch={exploreSearch}
      onOpenRecommendation={() => navigate({ kind: 'recommendations' })} onOpenBiliFeed={() => navigate({ kind: 'bili-feed' })}/>
    {query && <>
      <div className="large-tabs" role="tablist" aria-label="搜索类型">
        {(['video', 'creator'] as const).map((tab, index) => <button ref={tab === 'video' ? videoTab : undefined}
          type="button" role="tab" aria-selected={kind === tab} key={tab} onClick={() => setKind(tab)}>{['视频', 'UP主'][index]}</button>)}
      </div>
      <Failure error={results.error} retry={() => void results.refetch()}/>
      <Failure error={opener.error}/>
      <div className="large-grid large-search-results">
        {results.data?.pages.flatMap(page => page.videos?.items || []).map(video =>
          <LargeVideoCard key={video.bvid} video={video} opener={opener} focusPrefix="search"/>)}
        {results.data?.pages.flatMap(page => page.creators?.data.result || []).map(up => <Card key={up.mid} id={`up-${up.mid}`}
          creator title={up.uname} cover={up.upic} onClick={() => navigate({ kind: 'creator', item: { bvid: `up:${up.mid}`, title: up.uname, coverUrl: up.upic, uploaderName: up.uname, folderId: '' } })}/>)}
      </div>
      <NextPage query={results}/>
      {results.isSuccess && !results.data.pages.some(page => page.videos?.items.length || page.creators?.data.result?.length) && <Empty>没有找到相关内容</Empty>}
    </>}
  </>
}

export function LargeVideoCard({ video, opener, focusPrefix }: { video: BiliSearchItem; opener: ReturnType<typeof useVideoEntry>; focusPrefix: string }) {
  const title = video.title.replace(/<[^>]*>/g, '')
  return <Card id={`${focusPrefix}-${video.bvid}`} videoBvid={video.bvid} title={title}
    subtitle={`${video.uploaderName} · ${formatDuration(video.durationSeconds)}`} cover={video.coverUrl}
    pending={opener.pending === video.bvid} onClick={() => void opener.open({ ...video, title, folderId: '' })}/>
}

export function LargeCreator({ route, navigate, replace }: { route: Extract<Route, { kind: 'creator' }>; navigate: Navigate; replace: Navigate }) {
  const { item } = route, mid = Number(item.bvid.slice(3)), tab = route.tab || 'videos', [input, setInput] = useState(route.query || '')
  const result = useInfiniteQuery({ queryKey: accountQueryKey('large-creator', mid, tab, route.query || ''), initialPageParam: 1, queryFn: ({ pageParam }) => catalog(tab, mid, pageParam, route.query), getNextPageParam: last => last.page * (tab === 'videos' ? 30 : 20) < (tab === 'videos' ? last.data.page?.count || 0 : last.data.items_lists?.page?.total || 0) ? last.page + 1 : undefined })
  const saved = useQuery({ queryKey: accountQueryKey('collections'), queryFn: listCollections })
  const followed = saved.data?.items.some(creator => creator.bvid === item.bvid) ?? false
  const latest = useCollectionProgress(item.bvid, followed)
  const seasons = tab === 'seasons' ? result.data?.pages.flatMap(p => p.data.items_lists?.seasons_list || []) ?? [] : []
  const opener = useVideoEntry(navigate, `${item.bvid}:${tab}:${route.query ?? ''}`)
  const [resuming, setResuming] = useState(false), [resumeError, setResumeError] = useState<unknown>()
  const resumeVersion = useRef(0)
  useLayoutEffect(() => {
    setResuming(false)
    setResumeError(undefined)
    return () => { resumeVersion.current++ }
  }, [item.bvid, tab, route.query])
  const continueCreator = async () => {
    const checkpoint = latest.data
    if (!checkpoint || resuming) return
    const request = createCollectionResume(checkpoint), version = ++resumeVersion.current
    const active = () => version === resumeVersion.current && request.account === accountEpoch()
    const current = () => active() && isCurrentCollectionResume(request)
    setResuming(true)
    setResumeError(undefined)
    try {
      const target = await resolveCreatorContinuation(checkpoint, item, current)
      if (!target || !current()) return
      if ('collection' in target) navigate({ kind: 'collection', item: target.collection, resume: request })
      else await resumeCreatorUploads(item, checkpoint, target.detail, current, page => catalog('videos', mid, page),
        tab === 'videos' && !route.query ? result.data?.pages : undefined)
    } catch (error) { if (current()) setResumeError(error) }
    finally { if (active()) setResuming(false) }
  }
  return <>
    <header className="large-page-heading"><div><h1>{item.title}</h1></div>
      {followed && latest.data && <button type="button" data-focus="creator-continue" className="large-catalog-resume" disabled={resuming} onClick={() => void continueCreator()}>
        <History size={20}/>{resuming ? '正在读取' : '继续播放'}</button>}
    </header>
    <div className="large-tabs" role="tablist" aria-label="UP主内容">{(['videos', 'seasons'] as const).map((t, i) =>
      <button key={t} role="tab" aria-selected={tab === t} onClick={() => replace({ ...route, tab: t })}>{['视频', '合集'][i]}</button>)}</div>
    {tab === 'videos' && <form className="large-search" onSubmit={e => { e.preventDefault(); replace({ ...route, query: input.trim() }) }}>
      <Search size={22}/><input data-primary-focus aria-label="搜索这个UP主的视频" placeholder="搜索这个UP主的视频" value={input} onChange={e => setInput(e.target.value)}/><button type="submit">搜索</button>
    </form>}
    <Failure error={result.error} retry={() => void result.refetch()}/>
    <Failure error={resumeError}/>
    <Failure error={opener.error}/>
    <div className="large-catalog-list">
      {tab === 'videos' ? result.data?.pages.flatMap(p => p.data.list?.vlist || []).map(video => {
        const subtitle = [video.created ? new Date(video.created * 1000).toLocaleDateString() : '',
          video.play === undefined ? '' : `${formatPlayCount(video.play)} 播放`].filter(Boolean).join(' · ')
        return <div className="large-catalog-entry" key={video.bvid}>
          <Card row id={`video-${video.bvid}`} videoBvid={video.bvid} title={video.title} subtitle={subtitle} cover={video.pic}
            pending={opener.pending === video.bvid} onClick={() => void opener.open(
              { bvid: video.bvid, title: video.title, coverUrl: video.pic, uploaderName: item.title, folderId: '' }, { parentRef: item.bvid },
            )}/>
        </div>
      }) : seasons.map(({ meta }) => {
        const reference = `season:${mid}:${meta.season_id}`
        const collection = { bvid: reference, title: meta.name, coverUrl: meta.cover, uploaderName: item.title, folderId: '' }
        return <div className="large-catalog-entry" key={reference}>
          <Card row seasonReference={reference} id={`season-${meta.season_id}`} title={meta.name} subtitle={`${meta.total} 个视频`} cover={meta.cover} count={meta.total}
            onClick={() => navigate({ kind: 'collection', item: collection })}/>
        </div>
      })}
    </div>
    <NextPage query={result}/>
  </>
}
function NextPage({ query }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  return query.hasNextPage ? <button className="large-load-more" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '正在加载…' : '加载更多'}</button> : null
}
