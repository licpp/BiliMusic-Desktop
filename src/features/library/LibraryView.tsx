import { useLocateCurrentRow } from '../../shared/useLocateCurrentRow'
import { ActionMenu } from '../../shared/ActionMenu'
import { SegmentedTabs, type TabOption } from '../../shared/SegmentedTabs'
import { useSwipeTabs } from '../../shared/useSwipeTabs'
import { MobilePage } from '../../shared/MobilePage'
import { PlaylistMenu } from './PlaylistEntry'
import { open } from '@tauri-apps/plugin-dialog'
import { isMobile } from '../../services/platform'
import { accountEpoch } from '../../services/accountScope'
import { BatchTrackActions, useTrackSelection } from './useTrackSelection'
import { TrackMenuButton } from './TrackActions'
import { DownloadsView } from '../downloads/DownloadsView'
import { hydrateVisibleTracks } from '../../services/sync'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Download, Heart, Image as ImageIcon, Library, ListPlus, LoaderCircle, Play, RefreshCw, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { CatalogSource } from '../../services/desktopApi'
import { PlayingMark } from '../../shared/PlayingMark'
import { Artwork } from '../../shared/Artwork'
import type { Track } from '../../domain/track'
import { addTracksToPlaylist, commandErrorMessage, importLocalAudio, listLocalAudio, FAVORITES_PLAYLIST_ID, listLibraryTracks, listPlaylists, listPlaylistTracks, listRecentTracks, removeTracksFromPlaylist, saveLibraryTrack, searchMetadataCatalog, toggleStoredFavorite, updateStoredMetadata, type CatalogCandidate, type LocalImportResult, type Playlist } from '../../services/desktopApi'
import { showTrackMenu } from './trackActionStore'
import { formatDuration } from '../../shared/time'
import { useCompactLayout } from '../../shared/useCompactLayout'
import { usePlayerStore } from '../player/playerStore'

export type LibraryTab = 'saved' | 'recent' | 'downloads' | 'local'
export function MusicLibraryView({ tab, onTabChange }: { tab: LibraryTab; onTabChange: (tab: LibraryTab) => void }) {
  const tabs: TabOption<LibraryTab>[] = [{ id: 'saved', label: '已收藏' }, { id: 'recent', label: '最近播放' }, { id: 'downloads', label: '下载' }]
  if (!isMobile) tabs.splice(2, 0, { id: 'local', label: '本地音乐' })
  const swipe = useSwipeTabs(tabs.map(option => option.id), tab, onTabChange)
  return <div className="music-library">
    <SegmentedTabs tabs={tabs} value={tab} onChange={onTabChange} idPrefix="library-tab" panelId="music-library-panel" label="音乐库视图" className="library-tabs"/>
    <div id="music-library-panel" ref={swipe} data-swipe-tabs role="tabpanel" aria-labelledby={`library-tab-${tab}`}>
      <div className="segmented-panel" key={tab}>{tab === 'downloads' ? <DownloadsView/> : <LibraryView recent={tab === 'recent'} local={tab === 'local'}/>}</div>
    </div>
  </div>
}

export function LibraryView({ recent = false, local = false, playlist, onPlaylistDeleted, onRematchImported }: { recent?: boolean; local?: boolean; playlist?: Playlist; onPlaylistDeleted?: () => void; onRematchImported?:(playlist:Playlist)=>void }) {
  const client = useQueryClient()
  const play = usePlayerStore((state) => state.playFromList)
  const playAll = usePlayerStore((state) => state.playAll)
  const enqueue = usePlayerStore((state) => state.enqueue)
  const updatePlayerTrack = usePlayerStore((state) => state.updateTrack)
  const tracks = useQuery({ queryKey: ['library', local ? 'local' : recent ? 'recent' : 'saved', playlist?.id], queryFn: () => local ? listLocalAudio() : playlist ? listPlaylistTracks(playlist.id) : recent ? listRecentTracks() : listLibraryTracks(false, true) })
  const currentId = usePlayerStore(state => state.current?.id)
  const grid = useRef<HTMLDivElement>(null)
  useLocateCurrentRow(grid, Boolean(playlist), tracks.data?.some(track => track.id === currentId) ? currentId : undefined)
  const selection = useTrackSelection(tracks.data || [])
  const [importResult, setImportResult] = useState<LocalImportResult>()
  const [importError, setImportError] = useState('')
  const [favoriteError, setFavoriteError] = useState('')
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, boolean>>({})
  const [favoritePending, setFavoritePending] = useState<Set<string>>(() => new Set())
  const importFiles = useMutation({ mutationFn: async () => {
    const epoch = accountEpoch()
    const paths = await open({ multiple: true, title: '导入本地歌曲', filters: [{ name: '音频', extensions: ['mp3', 'm4a', 'wav'] }] })
    if (!paths || epoch !== accountEpoch()) return
    const result = await importLocalAudio(Array.isArray(paths) ? paths : [paths])
    if (epoch !== accountEpoch()) return
    setImportResult(result)
    await tracks.refetch()
  }, onError: cause => setImportError(commandErrorMessage(cause)) })
  useEffect(() => { void hydrateVisibleTracks(tracks.data, client).catch(() => undefined) }, [tracks.data, client])
  const isFavorites = playlist?.id === FAVORITES_PLAYLIST_ID
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['library'] }), client.invalidateQueries({ queryKey: ['playlists'] }), client.invalidateQueries({ queryKey: ['home-recent'] })])
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
    <header><div><span className="eyebrow">YOUR COLLECTION</span><h2>{playlist?.name || (local ? '本地音乐' : recent ? '最近播放' : '已收藏')}</h2><p>{playlist ? `${playlist.trackCount} 首歌曲 · ${playlist.isSystem ? '默认歌单，点击红心即可收藏或取消喜欢。' : '本地歌单'}` : local ? '导入 MP3、M4A 或 WAV 文件，在本机播放。' : recent ? '按最近一次播放整理，播放历史不会自动加入收藏。' : '收藏喜欢的歌曲，或将歌曲加入歌单，统一整理在这里。'}</p></div></header>

    {selection.selecting ? <BatchTrackActions selection={selection} total={tracks.data?.length || 0} onRemove={playlist ? async selected => {
      await removeTracksFromPlaylist(playlist.id, selected.map(track => track.id))
      if (isFavorites) selected.forEach(track => updatePlayerTrack({ ...track, liked: false }))
      await refresh()
    } : undefined} /> : <div className="collection-actions">
      {local && <button disabled={importFiles.isPending} onClick={() => { setImportError(''); importFiles.mutate() }}><Download size={16} />导入本地歌曲</button>}
      {(!isMobile || playlist || local) && <button disabled={!tracks.data?.length} onClick={selection.enter}>多选</button>}
      <button className="collection-primary" disabled={!tracks.data?.length} onClick={() => void playAll(tracks.data || [])}><Play size={16} />播放全部</button>{isMobile && !playlist && !local ? <ActionMenu sheet label="列表操作">{close => <>
        <button disabled={!tracks.data?.length} onClick={() => { close(); selection.enter() }}>多选</button>
        <button disabled={!tracks.data?.length} onClick={() => { close(); enqueue(tracks.data || []) }}><ListPlus size={16}/>全部加入队列</button>
      </>}</ActionMenu> : <button disabled={!tracks.data?.length} onClick={() => enqueue(tracks.data || [])}><ListPlus size={16} />全部加入队列</button>}{playlist && <PlaylistMenu playlist={playlist} onRemoved={onPlaylistDeleted} onRematch={playlist.id.startsWith('import:')&&onRematchImported?()=>onRematchImported(playlist):undefined}/>}</div>}
    {importError && <p className="inline-error">{importError}</p>}
    {importResult && <div className="batch-message" role="status">
      已导入 {importResult.added} 首，跳过 {importResult.alreadyImported} 首重复歌曲
      {importResult.failed.length > 0 && <details><summary>{importResult.failed.length} 个文件未导入</summary>{importResult.failed.map((error, index) => <p key={index}>{error}</p>)}</details>}
    </div>}
    {favoriteError && <p className="inline-error">{favoriteError}</p>}
    <div>
    {tracks.isLoading && <LibraryEmpty spinning title="正在读取资料库" detail="本地数据库正在准备歌曲信息" />}
    {tracks.isError && <LibraryEmpty title="资料库读取失败" detail={commandErrorMessage(tracks.error)} />}
    {tracks.data?.length === 0 && <LibraryEmpty title={local ? '还没有导入歌曲' : isFavorites ? '还没有喜欢的歌曲' : playlist ? '歌单还是空的' : recent ? '还没有播放记录' : '还没有收藏的歌曲'} detail={local ? '选择本机音频文件开始导入。' : isFavorites ? '点击歌曲旁的红心，或通过“加入歌单”添加到我喜欢。' : playlist ? '通过歌曲菜单把歌曲加入这里。' : recent ? '播放过的歌曲会出现在这里。' : '点击红心，或把歌曲加入歌单后，它会出现在这里。'} />}
    {Boolean(tracks.data?.length) && <div className="library-grid" ref={grid}>{tracks.data!.map((source, index) => { const track = favoriteOverrides[source.id] === undefined ? source : { ...source, liked: favoriteOverrides[source.id] }; return <article className={selection.selecting ? 'library-track selecting' : 'library-track playing-row'} data-current-row={currentId === track.id ? track.id : undefined} key={track.id} onContextMenu={(event) => { if (!selection.selecting) showTrackMenu(event, track, playlist?.id, tracks.data) }}>
      {selection.selecting ? <input className="track-select" type="checkbox" aria-label={`选择 ${track.title}`} checked={selection.ids.has(track.id)} onChange={() => selection.toggle(track.id)} /> :
      <button className="library-art" onClick={() => void play(tracks.data || [], track.id)} aria-label={`播放 ${track.title}`}>
        {track.coverUrl ? <Artwork src={track.coverUrl} adaptAspect /> : <span className={`tone-${index % 4}`} />}
        <i><Play fill="currentColor" /></i>
        {currentId === track.id && <PlayingMark/>}
      </button>}
      <div className="library-copy" role="button" aria-current={currentId === track.id ? 'true' : undefined} tabIndex={0} onClick={() => { if (!selection.selecting) void play(tracks.data || [], track.id) }} onKeyDown={event => { if (!selection.selecting && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void play(tracks.data || [], track.id) } }}><strong>{track.title}</strong><small>{track.artist || '歌手未知'}{track.album ? ` · ${track.album}` : ''}</small></div>
      <span className="library-duration">{formatDuration(track.durationSeconds)}</span>
      {!selection.selecting && <div className="library-track-actions">
      <button className={track.liked ? 'icon-action liked' : 'icon-action'} aria-busy={favoritePending.has(track.id)} onClick={() => void toggleFavorite(track)} aria-label={track.liked ? '取消喜欢' : '添加喜欢'}><Heart size={17} fill={track.liked ? 'currentColor' : 'none'} /></button>
      <TrackMenuButton track={track} playlistId={playlist?.id} tracks={tracks.data} />
      </div>}
    </article>})}</div>}
    </div>

  </section>
}

export function PlaylistPicker({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const client = useQueryClient()
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: listPlaylists })
  const [added, setAdded] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const add = async (playlistId: string) => {
    if (pending) return
    setPending(true)
    try {
    const epoch = accountEpoch()
    const saved: Track[] = []
    for (const track of tracks) {
      if (epoch !== accountEpoch()) return
      saved.push(await saveLibraryTrack(track))
    }
    if (epoch !== accountEpoch()) return
    await addTracksToPlaylist(playlistId, saved.map(track => track.id))
    if (epoch !== accountEpoch()) return
    if (playlistId === FAVORITES_PLAYLIST_ID) for (const track of saved) usePlayerStore.getState().updateTrack({ ...track, liked: true })
    setAdded(playlistId)
    await client.invalidateQueries({ queryKey: ['playlists'] })
    await client.invalidateQueries({ queryKey: ['library'] })
    await client.invalidateQueries({ queryKey: ['home-recent'] })
    } catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setPending(false) }
  }
  return <div className="dialog-backdrop playlist-picker-layer" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="playlist-picker" role="dialog" aria-modal="true"><header><div><span className="eyebrow">PLAYLIST</span><h3>添加到歌单</h3></div><button aria-label="关闭添加到歌单" onClick={onClose}><X /></button></header><p>{tracks.length === 1 ? tracks[0].title : `共 ${tracks.length} 首歌曲`}</p>{error && <p className="inline-error">{error}</p>}<div>{playlists.data?.filter(playlist => !playlist.biliFolderId).map((playlist) => <button key={playlist.id} disabled={pending} onClick={() => void add(playlist.id)}><span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首歌曲</small></span>{added === playlist.id ? <Check size={17} /> : <ListPlus size={17} />}</button>)}{playlists.data?.length === 0 && <small>请先在左侧创建歌单</small>}</div></div></div>
}

function LibraryEmpty({ title, detail, spinning }: { title: string; detail: string; spinning?: boolean }) {
  return <div className="library-empty"><span><Library className={spinning ? 'spin' : ''} /></span><h3>{title}</h3><p>{detail}</p></div>
}

export function MetadataDialog({ track, onClose, onSaved }: { track: Track; onClose: () => void; onSaved: (track: Track) => void }) {
  const [title, setTitle] = useState(track.title)
  const [artist, setArtist] = useState(track.artist || '')
  const [album, setAlbum] = useState(track.album || '')
  const [coverUrl, setCoverUrl] = useState(track.coverUrl || '')
  const catalogRequest = useRef(0)
  useEffect(() => () => { ++catalogRequest.current }, [])
  const [catalog, setCatalog] = useState<CatalogCandidate[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const compact = useCompactLayout()
  const [catalogSource, setCatalogSource] = useState<CatalogSource>('auto')
  const mutation = useMutation({ mutationFn: () => updateStoredMetadata(track.id, { title, artist, album, coverUrl }), onSuccess: onSaved })
  const submit = (event: FormEvent) => { event.preventDefault(); if (title.trim()) mutation.mutate() }
  const enrich = async (lookupTitle = title, lookupArtist = artist, source = catalogSource) => {
    const request = ++catalogRequest.current
    setCatalogOpen(true)
    if (!lookupTitle.trim()) { setCatalogLoading(false); setCatalogError('请填写用于搜索的歌曲名'); return }
    setCatalogLoading(true); setCatalogError(''); setCatalog([]); setSelectedCatalogId(null)
    try { const results = await searchMetadataCatalog(lookupTitle.trim(), lookupArtist.trim(), source); if (request !== catalogRequest.current) return; setCatalog(results); if (!results.length) setCatalogError('没有匹配结果，可以调整搜索信息或切换来源') }
    catch (cause) { if (request === catalogRequest.current) setCatalogError(commandErrorMessage(cause)) }
    finally { if (request === catalogRequest.current) setCatalogLoading(false) }
  }
  const pickCatalog = (item: CatalogCandidate) => {
    ++catalogRequest.current; setCatalogLoading(false)
    setTitle(item.trackName); setArtist(item.artistName)
    if (item.collectionName) setAlbum(item.collectionName)
    if (item.artworkUrl) setCoverUrl(item.artworkUrl)
    setSelectedCatalogId(item.trackId)
  }
  const sources: {value:CatalogSource;label:string}[] = [{value:'auto',label:'全部来源'},{value:'netease',label:'网易云音乐'},{value:'qq',label:'QQ 音乐'},{value:'itunes',label:'iTunes'},{value:'musicbrainz',label:'MusicBrainz'}]
  const editor = <div className="metadata-editor-content">
    <div className="metadata-track-preview"><Artwork src={coverUrl} adaptAspect/><div><strong>{title || '歌曲名'}</strong><small>{artist || '歌手未知'}</small>{album&&<small>{album}</small>}</div></div>
    <div className="metadata-fields"><label className="metadata-title-field">歌曲名<input aria-label="歌曲名" value={title} onChange={event=>setTitle(event.target.value)} required/></label><label>歌手<input aria-label="歌手" value={artist} onChange={event=>setArtist(event.target.value)} placeholder="歌手未知"/></label><label>专辑<input aria-label="专辑" value={album} onChange={event=>setAlbum(event.target.value)} placeholder="可选"/></label></div>
    <details className="metadata-cover-address"><summary><ImageIcon size={15}/><span>封面地址</span><ChevronDown size={14}/></summary><input aria-label="封面地址" value={coverUrl} onChange={event=>setCoverUrl(event.target.value)} placeholder="https://"/></details>
    <div className="metadata-match-toolbar"><div className="metadata-source-picker"><ActionMenu label="歌曲信息来源" sheet touchSheet={compact} panelClassName="metadata-source-menu" icon={<><span>{sources.find(item=>item.value===catalogSource)?.label}</span><ChevronDown size={14}/></>}>
      {close=><>{sources.map(item=><button type="button" role="menuitemradio" aria-checked={item.value===catalogSource} key={item.value} onClick={()=>{close();setCatalogSource(item.value);if(catalogOpen)void enrich(title,artist,item.value)}}><span>{item.label}</span>{item.value===catalogSource&&<Check size={16}/>}</button>)}</>}
    </ActionMenu></div><button className="metadata-match-button" type="button" disabled={catalogLoading||!title.trim()} onClick={()=>{(document.activeElement as HTMLElement|null)?.blur();void enrich()}}>{catalogLoading?<LoaderCircle size={16} className="spin"/>:catalogOpen?<RefreshCw size={16}/>:<Sparkles size={16}/>}<span>{catalogLoading?'正在匹配':catalogOpen?'重新匹配':'匹配歌曲信息'}</span></button></div>
    {catalogOpen&&<section className="metadata-match-results" aria-label="歌曲信息匹配结果" aria-busy={catalogLoading}>
      <header><strong>匹配结果</strong><small>{catalogLoading?'正在查找…':`${catalog.length} 个结果`}</small></header>
      {catalogError&&<p className="inline-error" role="alert">{catalogError}</p>}
      {catalog.map(item=><button type="button" key={item.trackId} className="metadata-match-result" aria-pressed={selectedCatalogId===item.trackId} onClick={()=>pickCatalog(item)}><Artwork src={item.artworkUrl}/><span><strong>{item.trackName}</strong><small>{item.artistName} · {item.collectionName||'专辑未知'}</small><span className="catalog-source-label">{item.source}</span></span>{selectedCatalogId===item.trackId&&<Check className="catalog-selected" size={18}/>}</button>)}
    </section>}
    {mutation.isError&&<p role="alert" className="inline-error">{commandErrorMessage(mutation.error)}</p>}
  </div>
  if(isMobile)return <MobilePage title="歌曲信息" onBack={onClose} className="mobile-metadata-page" actions={<button className="mobile-page-primary" type="submit" form="mobile-metadata-form" disabled={mutation.isPending||!title.trim()}>{mutation.isPending?'保存中':'保存'}</button>}><form id="mobile-metadata-form" className="metadata-editor-form" onSubmit={submit}>{editor}</form></MobilePage>
  return <div className="dialog-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><form className="metadata-dialog metadata-editor-form" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="metadata-title"><header><h3 id="metadata-title">编辑歌曲信息</h3><button type="button" onClick={onClose} aria-label="关闭"><X size={19}/></button></header>{editor}<footer><button type="button" onClick={onClose}>取消</button><button className="save-button" disabled={mutation.isPending||!title.trim()}>{mutation.isPending&&<LoaderCircle className="spin" size={15}/>}保存修改</button></footer></form></div>
}
