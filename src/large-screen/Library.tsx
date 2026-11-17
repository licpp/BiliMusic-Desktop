import { LargeBatchMatch } from './BatchMatch'
import { trackHidden, videoScope } from '../domain/contentVisibility'
import { useManagedVisibilityScope } from '../shared/useManagedVisibilityScope'
import { useVisibilityRules } from '../services/contentVisibility'
import { VisibilityControls } from '../shared/VisibilityControls'
import { matchesTrackSearch } from '../shared/ListSearch'
import { trackSubtitle } from '../domain/sourceTitle'
import { accountKeyAt, accountQueryKey } from '../services/queryKeys'
import { prepareListPlayback } from '../features/player/listPlayback'
import { resolveSeasonEntry, playbackIntent } from '../features/player/playerStore'
import { ListSort, useListSort } from '../shared/ListSort'
import { CoverBadge } from '../shared/CoverBadge'
import { loadCollectionMetadata } from './collectionMetadata'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { Folder, Heart, Link2, MoreHorizontal, Play, RefreshCw, Search, UserRound, X } from 'lucide-react'
import type { Track } from '../domain/track'
import { DownloadListButton } from './TrackActions'
import { playlistContext, collectionContext } from './playbackContext'
import { Artwork } from '../shared/Artwork'
import { formatDuration } from '../shared/time'
import { CoverCount } from '../shared/CoverCount'
import { PublishedDate } from '../shared/PublishedDate'
import { getVideoParts, listPlaylists, listPlaylistTracks, getLinkedFolder, searchBilibili, listSearchHistory, commandErrorMessage } from '../services/desktopApi'
import type { Playlist } from '../domain/library'
import type { LinkedFolder } from '../domain/bilibili'
import { listCollections, readCollectionProgress, type Collection, type Collections } from '../services/collections'
import { accountEpoch } from '../services/accountScope'
import { toTrack } from '../services/collectionTrack'
import { getSeason, parseSeasonReference, seasonTracks, creatorVideoRow } from '../services/mediaSources'
import { filterSeasonSection,seasonResumeSelection } from '../domain/seasonSections'
import { SeasonSections,useSeasonSection } from '../shared/SeasonSections'
import { hydrateVisibleTracks } from '../services/sync'
import { useListPreferences, playlistEntity } from '../services/listPreferences'
import { rankList, sortTracks } from '../services/listOrdering'
import { linkedFolderKey, reloadLinkedFolder } from '../services/linkedFolders'
import { usePlayerStore, type QueueSource } from '../features/player/playerStore'
import { useImportedPlaylist } from '../features/library/useImportedPlaylist'
import { ReplacementSearch } from '../features/library/ReplacementDialog'
import { ImportedPlaylistCompletionContent } from '../features/library/ImportedPlaylistCompletion'
import { LargeDialog } from './LargeDialog'
import type { ImportedEntry, ImportedEntriesSnapshot } from '../domain/importedEntry'

export type LibraryTab = 'playlists' | 'collections' | 'creators'
export type Route = { kind: 'home' | 'library' | 'search' | 'offline' | 'settings' | 'player' } | { kind: 'playlist'; playlist: Playlist } | { kind: 'folder'; id: string; title: string; scope: LibraryTab } | { kind: 'collection'; item: Collection } | { kind: 'creator'; item: Collection; tab?: 'videos' | 'seasons'; query?: string }
export type Navigate = (route: Route) => void
type FilterState = [string, (value: string) => void]
function useFilter(controlled?: FilterState): FilterState { const local = useState(''); return controlled || local }

export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  return error ? <div className="large-error" role="alert"><span>{commandErrorMessage(error)}</span>{retry && <button onClick={retry}><RefreshCw size={20}/>重试</button>}</div> : null
}
export function Empty({ children }: { children: ReactNode }) { return <div className="large-empty"><Search size={34}/><p>{children}</p></div> }
export function Card({ title, subtitle, cover, onClick, id, linked, folder, creator, count, elementRef, playlist }: { elementRef?: React.Ref<HTMLButtonElement>; playlist?: boolean; title: string; subtitle?: string; cover?: string; onClick: () => void; id: string; linked?: boolean; folder?: boolean; creator?: boolean; count?: number }) {
  const [aspect, setAspect] = useState<{ cover?: string; ratio: number }>()
  const ratio = aspect && aspect.cover === cover ? aspect.ratio : 16 / 9
  return <button style={{ '--large-card-ratio': ratio } as React.CSSProperties} className={`large-card${creator ? ' large-creator' : folder ? ' large-folder' : ''}${playlist ? ' large-playlist-card' : ''}`} ref={elementRef} data-focus={id} onClick={onClick}>
    <span className="large-card-art"><Artwork adaptAspect={!creator} onAspectRatio={ratio => setAspect({ cover, ratio })} src={cover} fallback={folder ? <Folder/> : creator ? <UserRound/> : title === '我喜欢' ? <Heart/> : undefined}/>{count && count > 1 ? <CoverCount count={count} single/> : null}{(linked || folder) && <CoverBadge kind={linked ? 'linked' : 'folder'}/>}</span>
    <strong>{title}</strong>{subtitle && <small>{subtitle}</small>}
  </button>
}
function CollectionCard({ item, navigate }: { item: Collection; navigate: Navigate }) {
  const ref = useRef<HTMLButtonElement>(null), client = useQueryClient(), epoch = accountEpoch()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '120px' })
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  const metadata = useQuery({ queryKey: accountKeyAt(epoch, 'large-collection-metadata', item.bvid), queryFn: () => loadCollectionMetadata(item, epoch), enabled: visible && (!item.title || !item.coverUrl || item.title === item.bvid), staleTime: 300000, retry: false })
  useEffect(() => {
    if (!metadata.data || epoch !== accountEpoch()) return
    client.setQueryData<Collections>(accountQueryKey('collections'), old => old ? { ...old, items: old.items.map(i => i.bvid === item.bvid ? { ...i, title: metadata.data!.title, coverUrl: metadata.data!.coverUrl, uploaderName: metadata.data!.uploaderName } : i) } : old)
  }, [metadata.data, client, epoch, item.bvid])
  const display = metadata.data ? { ...item, title: metadata.data.title, coverUrl: metadata.data.coverUrl, uploaderName: metadata.data.uploaderName } : item
  const creator = item.bvid.startsWith('up:')
  return <Card elementRef={ref} id={`collection-${item.bvid}`} creator={creator} title={item.note || display.title || (creator ? `UP 主 ${item.bvid.slice(3)}` : '正在读取合集…')} subtitle={item.note ? display.title : creator ? undefined : display.uploaderName} cover={display.coverUrl} onClick={() => navigate({ kind: creator ? 'creator' : 'collection', item: display })}/>
}
export function LargeLibrary({ tab, setTab, navigate, folder, filterState }: { filterState?: FilterState; tab: LibraryTab; setTab: (tab: LibraryTab) => void; navigate: Navigate; folder?: Extract<Route, { kind: 'folder' }> }) {
  const playlists = useQuery({ queryKey: accountQueryKey('playlists'), queryFn: listPlaylists })
  const collections = useQuery({ queryKey: accountQueryKey('collections'), queryFn: listCollections })
  const prefs = useListPreferences(), preferences = prefs.data?.preferences || []
  const [filter, setFilter] = useFilter(filterState)
  const scope = folder?.scope || tab
  const matches = (text: string) => text.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())
  const items = collections.data?.items.filter(i => i.bvid.startsWith('up:') === (scope === 'creators') && (!folder ? !i.folderId : i.folderId === folder.id)) || []
  const folders = folder ? [] : (collections.data?.folders || []).filter(f => (f.scope === 'creators') === (scope === 'creators'))
  const error = scope === 'playlists' ? playlists.error : collections.error
  return <>
    {folder && <header className="large-page-heading"><h1>{folder.title}</h1></header>}
    {!folder && <div className="large-tabs" role="tablist" aria-label="音乐库分类">{(['playlists', 'collections', 'creators'] as const).map((t, i) => <button role="tab" aria-selected={tab === t} key={t} data-focus={`library-${t}`} onClick={() => { setFilter(''); setTab(t) }}>{['歌单', '收藏', '关注'][i]}</button>)}</div>}
    <ListFilter value={filter} onChange={setFilter} label={scope === 'creators' ? '查找关注的 UP 主' : '查找音乐库'}/>
    <Failure error={error} retry={() => { void playlists.refetch(); void collections.refetch() }}/>
    <div className="large-grid">
      {scope === 'playlists' ? rankList(playlists.data || [], preferences, playlistEntity).filter(p => matches(p.name)).map(p => <Card playlist key={p.id} id={`playlist-${p.id}`} title={p.name} subtitle={`${p.trackCount} ${p.biliFolderId ? '个视频' : '首'}`} cover={p.coverUrl} linked={Boolean(p.biliFolderId)} onClick={() => navigate({ kind: 'playlist', playlist: p })}/>) : <>
        {rankList(folders, preferences, f => `${scope === 'creators' ? 'creatorFolder' : 'collectionFolder'}:${f.id}`).filter(f => matches(f.name)).map(f => <Card key={f.id} id={`folder-${f.id}`} folder title={f.name} cover={collections.data?.items.find(i => i.folderId === f.id && i.coverUrl)?.coverUrl} onClick={() => navigate({ kind: 'folder', id: f.id, title: f.name, scope })}/>)}
        {rankList(items, preferences, i => `collection:${i.bvid}`).filter(i => matches(i.note || i.title)).map(i => <CollectionCard key={i.bvid} item={i} navigate={navigate}/>)}
      </>}
    </div>
    {!error && !(scope === 'playlists' ? playlists.isPending || playlists.data?.length : collections.isPending || items.length || folders.length) && <Empty>还没有内容，可以连接坚果云同步音乐库</Empty>}
  </>
}

export function ListFilter({ value, onChange, label = '搜索列表中的音乐' }: { value: string; onChange: (value: string) => void; label?: string }) {
  return <label className="large-search"><Search size={22}/><input data-primary-focus aria-label={label} placeholder={label} value={value} onChange={e => onChange(e.target.value)}/>{value && <button aria-label="清空搜索" onClick={() => onChange('')}><X size={20}/></button>}</label>
}
export function TrackRows({ tracks, source, onMore, onPlayed, onOpen,visibilityScope,playbackTracks=tracks,importedEntries }: { importedEntries?:ImportedEntry[];visibilityScope?:string;playbackTracks?:Track[];tracks: Track[]; source?: QueueSource; onMore: (track: Track) => void; onPlayed?: () => void; onOpen?: (track: Track) => void }) {
  const rules=useVisibilityRules()
  const id = usePlayerStore(s => s.current?.id), status = usePlayerStore(s => s.status)
  const origins=new Map(importedEntries?.filter(e=>e.trackId).map(e=>[e.trackId,e.song]))
  return <div className="large-tracks">{tracks.map((track, index) => {const origin=track.titleOverridden?undefined:origins.get(track.id);return <div className={`large-track${track.id === id ? ' current' : ''}${visibilityScope&&trackHidden(track,visibilityScope,rules)?' visibility-hidden':''}`} key={track.id}>
    <button disabled={Boolean(visibilityScope&&trackHidden(track,visibilityScope,rules))} className="large-track-main" data-focus={`track-${track.id}`} onClick={() => { if (onOpen) onOpen(track); else { void usePlayerStore.getState().playFromList(playbackTracks, track.id, source); onPlayed?.() } }}>
      <span className="large-track-number">{track.id === id && status === 'playing' ? <span className="large-playing-mark">ııı</span> : index + 1}</span><span className="large-track-art"><Artwork adaptAspect src={origin?.coverUrl||track.coverUrl}/></span><span className="large-track-copy"><strong>{origin?.title||track.displayTitle || track.title}</strong><small>{origin?origin.artists.join(' / ')||'歌手未知':trackSubtitle(track,source)}<PublishedDate value={track.publishedAt}/></small></span><span className="large-track-duration">{formatDuration(track.durationSeconds)}</span>
    </button><button className="large-icon large-track-more" data-focus={`more-${track.id}`} aria-label={`${track.title}的更多操作`} onClick={() => onMore(track)}><MoreHorizontal/></button>
  </div>})}</div>
}

export function LargePlaylist({ playlist, onMore, navigate, filterState }: { filterState?: FilterState; playlist: Playlist; onMore: (t: Track,replaceVideo?:()=>void) => void; navigate: Navigate }) {
  const client = useQueryClient(), prefs = useListPreferences(), epoch = accountEpoch()
  const linked = playlist.biliFolderId
  const imported=useImportedPlaylist(playlist)
  const [replacement,setReplacement]=useState<ImportedEntry>(),[completion,setCompletion]=useState(false),[matching,setMatching]=useState(false)
  const query = useQuery<Track[] | LinkedFolder | null>({ queryKey: linked ? linkedFolderKey(linked) : accountQueryKey('library', playlist.id), queryFn: () => linked ? getLinkedFolder(linked) : listPlaylistTracks(playlist.id) })
  const [filter, setFilter] = useFilter(filterState), [refreshError, setRefreshError] = useState<unknown>()
  useEffect(() => { let alive = true; if (linked) void reloadLinkedFolder(client, linked).catch(e => { if (alive) setRefreshError(e) }); return () => { alive = false } }, [linked, client, epoch])
  const raw = Array.isArray(query.data) ? query.data : query.data ? seasonTracks({ unavailable: 0, summary: { id: linked!, uploaderId: 0, title: playlist.name, uploaderName: '', coverUrl: '' }, tracks: query.data.videos.map(v => ({ bvid: v.bvid, aid: v.aid || 0, cid: 0, title: v.title, coverUrl: v.cover, durationSeconds: v.duration || 0, publishedAt: v.pubtime, playCount: v.cnt_info?.play })) }) : []
  useEffect(() => { if (!linked && Array.isArray(query.data)) void hydrateVisibleTracks(query.data, client).catch(() => undefined) }, [query.data, linked, client])
  const entity = playlistEntity(playlist), rule = prefs.data?.preferences.find(p => p.entity === entity)?.sortRule || 'source:asc'
  const tracks = sortTracks(raw, rule, prefs.data?.dates || {}, prefs.data?.playCounts || {}).filter(t => {const entry=imported.byTrack.get(t.id);return matchesTrackSearch(t,filter)||Boolean(entry&&`${entry.song.title} ${entry.song.artists.join(' ')} ${entry.song.album||''}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))})
  const source = playlistContext(playlist.name, Boolean(linked))
  const replaced=(snapshot:ImportedEntriesSnapshot)=>{
    const epoch=accountEpoch(),trackId=snapshot.entries.find(e=>e.entryId===replacement?.entryId)?.trackId
    client.setQueryData(accountQueryKey('imported-entries',playlist.id),snapshot);setReplacement(undefined)
    void query.refetch().then(()=>requestAnimationFrame(()=>{if(epoch!==accountEpoch())return;[...document.querySelectorAll<HTMLElement>('[data-focus]')].find(el=>el.dataset.focus===`more-${trackId}`)?.focus({preventScroll:true})}))
    void client.invalidateQueries({queryKey:accountQueryKey('playlists')})
  }
  return <><header className="large-page-heading"><div><h1>{playlist.name}{linked && <Link2 size={22}/>}</h1><p>{raw.length} {linked ? '个视频 · B站关联收藏夹' : '首歌曲'}</p></div><div className="large-toolbar"><ListSort entity={entity}/>{!linked&&<button disabled={!tracks.length} onClick={()=>setMatching(true)}>自动匹配</button>}{imported.missing.length>0&&<button onClick={()=>setCompletion(true)}><RefreshCw/>补全未匹配 · {imported.missing.length}</button>}<DownloadListButton tracks={tracks}/><button className="large-primary" disabled={!tracks.length} onClick={() => void usePlayerStore.getState().playFromList(tracks, tracks[0].id, source)}><Play/>播放全部</button></div></header><ListFilter value={filter} onChange={setFilter}/><Failure error={query.error || refreshError} retry={() => { void query.refetch(); if (linked) void reloadLinkedFolder(client, linked).then(() => setRefreshError(undefined)).catch(setRefreshError) }}/><TrackRows tracks={tracks} source={source} importedEntries={imported.entries} onMore={track=>{const entry=imported.byTrack.get(track.id);onMore(track,entry?()=>setReplacement(entry):undefined)}} onOpen={linked ? t => navigate({ kind: 'collection', item: { bvid: t.source.bvid, folderId: '', title: t.title, coverUrl: t.coverUrl || '', uploaderName: t.source.uploaderName || '' } }) : undefined}/>{!query.isPending && !tracks.length && <Empty>{filter ? '没有匹配的歌曲' : '这个歌单还没有歌曲'}</Empty>}
    {matching&&<LargeBatchMatch tracks={tracks} onClose={()=>setMatching(false)}/>}
    {replacement&&imported.data&&<LargeDialog title="更换视频" className="import-match-large-dialog" onClose={()=>setReplacement(undefined)}><ReplacementSearch entry={replacement} session={imported.data.session} currentTrack={raw.find(t=>t.id===replacement.trackId)} onSaved={replaced} onClose={()=>setReplacement(undefined)}/></LargeDialog>}
    {completion&&<LargeDialog title="补全未匹配" className="import-match-large-dialog" onClose={()=>setCompletion(false)}><ImportedPlaylistCompletionContent playlist={playlist} onClose={()=>setCompletion(false)} renderReplacement={props=><LargeDialog title="更换视频" className="import-match-large-dialog" onClose={props.onClose}><ReplacementSearch {...props}/></LargeDialog>}/></LargeDialog>}
  </>
}

export function LargeCollection({ item, onMore, navigate, filterState }: { filterState?: FilterState; item: Collection; onMore: (t: Track,visibilityScope?:string) => void; navigate: Navigate }) {
  const season = parseSeasonReference(item.bvid), [filter, setFilter] = useFilter(filterState)
  const query = useQuery({ queryKey: accountQueryKey('large-collection', item.bvid), queryFn: async () => { if (season) { const data = await getSeason(season.mid, season.seasonId); return { tracks: seasonTracks(data), sections:data.sections, season: undefined, title: data.summary.title, uploaderName: data.summary.uploaderName } }; const detail = await getVideoParts(item.bvid); return { tracks: detail.parts.map(p => toTrack(detail, p)), sections:undefined, season: detail.season, title: detail.title, uploaderName: detail.uploaderName } } })
  const progress = useQuery({ queryKey: accountQueryKey('collection-progress', item.bvid), queryFn: () => readCollectionProgress(item.bvid) })
  const rules=useVisibilityRules(), [shown,setShown]=useState(false)
  const scope=useManagedVisibilityScope(season?item.bvid:videoScope(item.bvid),query.data?.tracks ?? [])
  const isHidden=(track:Track)=>Boolean(scope && trackHidden(track,scope,rules))
  const sorting = useListSort(`collection:${item.bvid}`)
  const [selectedSection,setSelectedSection] = useSeasonSection(item.bvid,query.data?.sections)
  const ordered = sortTracks(filterSeasonSection(query.data?.tracks || [],query.data?.sections,selectedSection), sorting.rule, sorting.dates, sorting.playCounts)
  const tracks = ordered.filter(t => (shown || !isHidden(t)) && matchesTrackSearch(t,filter))
  const resumeTracks=sortTracks(query.data?.tracks || [],sorting.rule,sorting.dates,sorting.playCounts)
  const playable=resumeTracks.filter(t=>!isHidden(t))
  const checkpoint = progress.data
  const canResume = checkpoint && playable.length>0 && resumeTracks.some(t => t.source.bvid === checkpoint.bvid && (t.source.cid === checkpoint.cid || t.resolveParts))
  const source = { ...collectionContext(query.data?.title || item.title, item.bvid, Boolean(season), query.data?.tracks.length || 0), visibilityManaged: Boolean(scope) }
  const [playError, setPlayError] = useState('')
  const playVersion = useRef(0)
  useEffect(() => { setPlayError(''); return () => { playVersion.current++ } }, [item.bvid])
  const play = async (resume = false) => {
    const epoch = accountEpoch(), intent = playbackIntent(), version = ++playVersion.current
    const current = () => version === playVersion.current && epoch === accountEpoch() && intent === playbackIntent()
    setPlayError('')
    try {
      if (resume && !progress.data) return
      const prepared = await prepareListPlayback(resume ? resumeTracks : tracks, resume ? progress.data ?? undefined : undefined, resolveSeasonEntry, current,t=>!isHidden(t))
      if (!current()) return
      if (!prepared) { setPlayError('没有可继续播放的内容。'); return }
      const selection = resume ? seasonResumeSelection(prepared.queue,prepared.trackId,query.data?.sections,selectedSection) : {tracks:prepared.queue,sectionId:selectedSection}
      if (resume) { setSelectedSection(selection.sectionId); setFilter('') }
      await usePlayerStore.getState().playFromList(selection.tracks, prepared.trackId, source, prepared.startAt, true)
    } catch (error) { if (current()) setPlayError(commandErrorMessage(error)) }
  }
  return <><header className="large-page-heading"><div><h1>{query.data?.title || item.title || '合集'}</h1><p>{query.data?.uploaderName || item.uploaderName} · {query.data?.tracks.length || 0} {season ? '集' : 'P'}</p></div><div className="large-toolbar"><ListSort entity={`collection:${item.bvid}`}/><DownloadListButton tracks={tracks}/>{canResume && <button onClick={() => play(true)}>继续上次</button>}<button className="large-primary" disabled={!tracks.length} onClick={() => play()}><Play/>播放全部</button></div></header>{query.data?.season && <button className="large-text-button" onClick={() => { const s = query.data!.season!; navigate({ kind: 'collection', item: { bvid: `season:${s.uploaderId}:${s.id}`, title: s.title, coverUrl: s.coverUrl, uploaderName: s.uploaderName, folderId: '' } }) }}>查看所属合集</button>}<SeasonSections sections={query.data?.sections} selected={selectedSection} onChange={setSelectedSection}/>{scope && <VisibilityControls scope={scope} rules={rules} shown={shown} onShow={setShown} tracks={query.data?.tracks||[]}/>}<ListFilter value={filter} onChange={setFilter}/><Failure error={query.error || (playError ? new Error(playError) : null)} retry={() => void query.refetch()}/>{query.isPending ? <p className="large-muted" role="status">正在读取内容…</p> : <TrackRows visibilityScope={scope} tracks={tracks} playbackTracks={ordered} source={source} onMore={track=>onMore(track,scope)} onOpen={season ? track => navigate({ kind: 'collection', item: { bvid: track.source.bvid, title: track.videoTitle || track.title, coverUrl: track.coverUrl || '', uploaderName: item.uploaderName, folderId: '' } }) : undefined}/>}</>
}


type Creator = { mid: number; uname: string; upic: string; fans?: number }
type Catalog = { page: number; data: { numResults?: number; result?: Creator[]; page?: { count: number }; list?: { vlist: Parameters<typeof creatorVideoRow>[0][] }; items_lists?: { page?: { total: number }; seasons_list?: { meta: { season_id: number; name: string; cover: string; total: number } }[] } } }
const catalog = (action: string, mid: number | undefined, page: number, keyword = '') => invoke<Catalog>('bili_creator_catalog', { action, mid, page, keyword })

export function LargeSearch({ query, setQuery, navigate, kind, setKind }: { kind: 'video' | 'creator'; setKind: (kind: 'video' | 'creator') => void; query: string; setQuery: (q: string) => void; navigate: Navigate }) {
  const [input, setInput] = useState(query)
  const history = useQuery({ queryKey: accountQueryKey('search-history'), queryFn: listSearchHistory })
  const results = useInfiniteQuery({ queryKey: accountQueryKey('large-search', kind, query), initialPageParam: 1, enabled: Boolean(query), queryFn: async ({ pageParam }) => kind === 'video' ? { videos: await searchBilibili(query, pageParam), creators: undefined } : { videos: undefined, creators: await catalog('search', undefined, pageParam, query) }, getNextPageParam: last => last.videos ? last.videos.page * last.videos.pageSize < last.videos.total ? last.videos.page + 1 : undefined : last.creators && last.creators.page * 20 < (last.creators.data.numResults || 0) ? last.creators.page + 1 : undefined })
  const submit = () => { const bv = /BV[0-9a-z]{10}/i.exec(input); if (bv) navigate({ kind: 'collection', item: { bvid: bv[0], title: bv[0], folderId: '', coverUrl: '', uploaderName: '' } }); else setQuery(input.trim()) }
  return <><form className="large-search" onSubmit={e => { e.preventDefault(); submit() }}><Search size={24}/><input data-primary-focus data-focus="search-input" value={input} onChange={e => setInput(e.target.value)} placeholder="想听什么？" aria-label="搜索音乐或UP主"/><button className="large-primary" type="submit">搜索</button></form><div className="large-tabs" role="tablist" aria-label="搜索类型">{(['video', 'creator'] as const).map((t, i) => <button role="tab" aria-selected={kind === t} key={t} onClick={() => setKind(t)}>{['视频', 'UP主'][i]}</button>)}</div>{!query && <div className="large-history">{history.data?.map(q => <button key={q} onClick={() => { setInput(q); setQuery(q) }}>{q}</button>)}</div>}<Failure error={results.error} retry={() => void results.refetch()}/><div className="large-grid large-search-results">{results.data?.pages.flatMap(p => p.videos?.items || []).map(v => <Card key={v.bvid} id={`search-${v.bvid}`} title={v.title.replace(/<[^>]*>/g, '')} subtitle={`${v.uploaderName} · ${formatDuration(v.durationSeconds)}`} cover={v.coverUrl} onClick={() => navigate({ kind: 'collection', item: { bvid: v.bvid, title: v.title.replace(/<[^>]*>/g, ''), coverUrl: v.coverUrl, uploaderName: v.uploaderName, folderId: '' } })}/>)}{results.data?.pages.flatMap(p => p.creators?.data.result || []).map(up => <Card key={up.mid} id={`up-${up.mid}`} creator title={up.uname} cover={up.upic} onClick={() => navigate({ kind: 'creator', item: { bvid: `up:${up.mid}`, title: up.uname, coverUrl: up.upic, uploaderName: up.uname, folderId: '' } })}/>)}</div><NextPage query={results}/>{query && results.isSuccess && !results.data.pages.some(p => p.videos?.items.length || p.creators?.data.result?.length) && <Empty>没有找到相关内容</Empty>}</>
}
export function LargeCreator({ route, navigate, replace }: { route: Extract<Route, { kind: 'creator' }>; navigate: Navigate; replace: Navigate }) {
  const { item } = route, mid = Number(item.bvid.slice(3)), tab = route.tab || 'videos', [input, setInput] = useState(route.query || '')
  const result = useInfiniteQuery({ queryKey: accountQueryKey('large-creator', mid, tab, route.query || ''), initialPageParam: 1, queryFn: ({ pageParam }) => catalog(tab, mid, pageParam, route.query), getNextPageParam: last => last.page * (tab === 'videos' ? 30 : 20) < (tab === 'videos' ? last.data.page?.count || 0 : last.data.items_lists?.page?.total || 0) ? last.page + 1 : undefined })
  return <><header className="large-page-heading"><div><h1>{item.title}</h1></div></header><div className="large-tabs" role="tablist" aria-label="UP主内容">{(['videos', 'seasons'] as const).map((t, i) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => replace({ ...route, tab: t })}>{['视频', '合集'][i]}</button>)}</div>{tab === 'videos' && <form className="large-search" onSubmit={e => { e.preventDefault(); replace({ ...route, query: input.trim() }) }}><Search size={22}/><input data-primary-focus aria-label="搜索这个UP主的视频" placeholder="搜索这个UP主的视频" value={input} onChange={e => setInput(e.target.value)}/><button type="submit">搜索</button></form>}<Failure error={result.error} retry={() => void result.refetch()}/><div className="large-grid">{tab === 'videos' ? result.data?.pages.flatMap(p => p.data.list?.vlist || []).map(v => <Card key={v.bvid} id={`video-${v.bvid}`} title={v.title} subtitle={v.created ? new Date(v.created * 1000).toLocaleDateString() : ''} cover={v.pic} onClick={() => navigate({ kind: 'collection', item: { bvid: v.bvid, title: v.title, coverUrl: v.pic, uploaderName: item.title, folderId: '' } })}/>) : result.data?.pages.flatMap(p => p.data.items_lists?.seasons_list || []).map(s => <Card key={s.meta.season_id} id={`season-${s.meta.season_id}`} title={s.meta.name} count={s.meta.total} subtitle={`${s.meta.total} 个视频`} cover={s.meta.cover} onClick={() => navigate({ kind: 'collection', item: { bvid: `season:${mid}:${s.meta.season_id}`, title: s.meta.name, coverUrl: s.meta.cover, uploaderName: item.title, folderId: '' } })}/>)}</div><NextPage query={result}/></>
}
function NextPage({ query }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  return query.hasNextPage ? <button className="large-load-more" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '正在加载…' : '加载更多'}</button> : null
}
