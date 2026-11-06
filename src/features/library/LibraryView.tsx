import { PlaylistMenu } from './PlaylistEntry'
import { open } from '@tauri-apps/plugin-dialog'
import { isAndroid } from '../../services/platform'
import { accountEpoch } from '../../services/accountScope'
import { BatchTrackActions, useTrackSelection } from './useTrackSelection'
import { TrackMenuButton } from './TrackActions'
import { DownloadsView } from '../downloads/DownloadsView'
import { hydrateVisibleTracks } from '../../services/sync'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Download, Heart, Library, ListPlus, LoaderCircle, Play, Sparkles, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { CatalogSource } from '../../services/desktopApi'
import { Artwork } from '../../shared/Artwork'
import type { Track } from '../../domain/track'
import { addTrackToPlaylist, commandErrorMessage, importLocalAudio, listLocalAudio, FAVORITES_PLAYLIST_ID, listLibraryTracks, listPlaylists, listPlaylistTracks, listRecentTracks, removeTracksFromPlaylist, saveLibraryTrack, searchMetadataCatalog, toggleStoredFavorite, updateStoredMetadata, type CatalogCandidate, type LocalImportResult, type Playlist } from '../../services/desktopApi'
import { showTrackMenu } from './trackActionStore'
import { formatDuration } from '../../shared/time'
import { usePlayerStore } from '../player/playerStore'

export type LibraryTab = 'saved' | 'recent' | 'downloads' | 'local'
export function MusicLibraryView({ tab, onTabChange }: { tab: LibraryTab; onTabChange: (tab: LibraryTab) => void }) {
  const tabs: [LibraryTab,string][] = [['saved','已收藏'],['recent','最近播放'],['downloads','下载']]
  if (!isAndroid) tabs.splice(2, 0, ['local','本地音乐'])
  return <div className="music-library"><div className="library-tabs" role="tablist" aria-label="音乐库视图" onKeyDown={e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const i=tabs.findIndex(t=>t[0]===tab);const next=tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length][0];onTabChange(next);e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()}}>{tabs.map(([id,label])=><button id={`library-tab-${id}`} key={id} role="tab" data-tab={id} aria-selected={tab===id} tabIndex={tab===id?0:-1} aria-controls="music-library-panel" onClick={()=>onTabChange(id)}>{label}</button>)}</div><div id="music-library-panel" role="tabpanel" aria-labelledby={`library-tab-${tab}`}>{tab==='downloads' ? <DownloadsView /> : <LibraryView key={tab} recent={tab==='recent'} local={tab==='local'} />}</div></div>
}

export function LibraryView({ recent = false, local = false, playlist, onPlaylistDeleted }: { recent?: boolean; local?: boolean; playlist?: Playlist; onPlaylistDeleted?: () => void }) {
  const client = useQueryClient()
  const play = usePlayerStore((state) => state.playFromList)
  const playAll = usePlayerStore((state) => state.playAll)
  const enqueue = usePlayerStore((state) => state.enqueue)
  const updatePlayerTrack = usePlayerStore((state) => state.updateTrack)
  const tracks = useQuery({ queryKey: ['library', local ? 'local' : recent ? 'recent' : 'saved', playlist?.id], queryFn: () => local ? listLocalAudio() : playlist ? listPlaylistTracks(playlist.id) : recent ? listRecentTracks() : listLibraryTracks(false, true) })
  const selection = useTrackSelection(tracks.data || [])
  const [importResult, setImportResult] = useState<LocalImportResult>()
  const [importError, setImportError] = useState('')
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
  const favorite = useMutation({
    mutationFn: toggleStoredFavorite,
    onSuccess: (liked, id) => { const track = tracks.data?.find((item) => item.id === id); if (track) updatePlayerTrack({ ...track, liked }); return refresh() },
  })
  return <section className="library-view">
    <header><div><span className="eyebrow">YOUR COLLECTION</span><h2>{playlist?.name || (local ? '本地音乐' : '音乐库')}</h2><p>{playlist ? `${playlist.trackCount} 首歌曲 · ${playlist.isSystem ? '默认歌单，点击红心即可收藏或取消喜欢。' : '本地歌单'}` : local ? '导入 MP3、M4A 或 WAV 文件，在本机播放。' : recent ? '按最近一次播放整理，播放历史不会自动加入收藏。' : '收藏喜欢的歌曲，或将歌曲加入歌单，统一整理在这里。'}</p></div></header>

    {selection.selecting ? <BatchTrackActions selection={selection} total={tracks.data?.length || 0} onRemove={playlist ? async selected => {
      await removeTracksFromPlaylist(playlist.id, selected.map(track => track.id))
      if (isFavorites) selected.forEach(track => updatePlayerTrack({ ...track, liked: false }))
      await refresh()
    } : undefined} /> : <div className="collection-actions">
      {local && <button disabled={importFiles.isPending} onClick={() => { setImportError(''); importFiles.mutate() }}><Download size={16} />导入本地歌曲</button>}
      <button disabled={!tracks.data?.length} onClick={selection.enter}>多选</button>
      <button className="collection-primary" disabled={!tracks.data?.length} onClick={() => void playAll(tracks.data || [])}><Play size={16} />播放全部</button><button disabled={!tracks.data?.length} onClick={() => enqueue(tracks.data || [])}><ListPlus size={16} />全部加入队列</button>{playlist && <PlaylistMenu playlist={playlist} onRemoved={onPlaylistDeleted}/>}</div>}
    {importError && <p className="inline-error">{importError}</p>}
    {importResult && <div className="batch-message" role="status">
      已导入 {importResult.added} 首，跳过 {importResult.alreadyImported} 首重复歌曲
      {importResult.failed.length > 0 && <details><summary>{importResult.failed.length} 个文件未导入</summary>{importResult.failed.map((error, index) => <p key={index}>{error}</p>)}</details>}
    </div>}
    {favorite.isError && <p className="inline-error">{commandErrorMessage(favorite.error)}</p>}
    <div>
    {tracks.isLoading && <LibraryEmpty spinning title="正在读取资料库" detail="本地数据库正在准备歌曲信息" />}
    {tracks.isError && <LibraryEmpty title="资料库读取失败" detail={commandErrorMessage(tracks.error)} />}
    {tracks.data?.length === 0 && <LibraryEmpty title={local ? '还没有导入歌曲' : isFavorites ? '还没有喜欢的歌曲' : playlist ? '歌单还是空的' : recent ? '还没有播放记录' : '还没有收藏的歌曲'} detail={local ? '选择本机音频文件开始导入。' : isFavorites ? '点击歌曲旁的红心，或通过“加入歌单”添加到我喜欢。' : playlist ? '通过歌曲菜单把歌曲加入这里。' : recent ? '播放过的歌曲会出现在这里。' : '点击红心，或把歌曲加入歌单后，它会出现在这里。'} />}
    {Boolean(tracks.data?.length) && <div className="library-grid">{tracks.data!.map((track, index) => <article className={selection.selecting ? 'library-track selecting' : 'library-track'} key={track.id} onContextMenu={(event) => { if (!selection.selecting) showTrackMenu(event, track, playlist?.id, tracks.data) }}>
      {selection.selecting ? <input className="track-select" type="checkbox" aria-label={`选择 ${track.title}`} checked={selection.ids.has(track.id)} onChange={() => selection.toggle(track.id)} /> :
      <button className="library-art" onClick={() => void play(tracks.data || [], track.id)} aria-label={`播放 ${track.title}`}>
        {track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" /> : <span className={`tone-${index % 4}`} />}
        <i><Play fill="currentColor" /></i>
      </button>}
      <div className="library-copy"><strong>{track.title}</strong><small>{track.artist || '歌手未知'}{track.album ? ` · ${track.album}` : ''}</small></div>
      <span className="library-duration">{formatDuration(track.durationSeconds)}</span>
      {!selection.selecting && <div className="library-track-actions">
      <button className={track.liked ? 'icon-action liked' : 'icon-action'} onClick={() => favorite.mutate(track.id)} aria-label={track.liked ? '取消喜欢' : '添加喜欢'}><Heart size={17} fill={track.liked ? 'currentColor' : 'none'} /></button>
      <TrackMenuButton track={track} playlistId={playlist?.id} tracks={tracks.data} />
      </div>}
    </article>)}</div>}
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
    for (const track of tracks) { const stored = await saveLibraryTrack(track); await addTrackToPlaylist(playlistId, stored.id); if (playlistId === FAVORITES_PLAYLIST_ID) usePlayerStore.getState().updateTrack({ ...stored, liked: true }) }
    setAdded(playlistId)
    await client.invalidateQueries({ queryKey: ['playlists'] })
    await client.invalidateQueries({ queryKey: ['library'] })
    await client.invalidateQueries({ queryKey: ['home-recent'] })
    } catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setPending(false) }
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="playlist-picker" role="dialog" aria-modal="true"><header><div><span className="eyebrow">PLAYLIST</span><h3>添加到歌单</h3></div><button onClick={onClose}><X /></button></header><p>{tracks.length === 1 ? tracks[0].title : `共 ${tracks.length} 首歌曲`}</p>{error && <p className="inline-error">{error}</p>}<div>{playlists.data?.filter(playlist => !playlist.biliFolderId).map((playlist) => <button key={playlist.id} disabled={pending} onClick={() => void add(playlist.id)}><span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首歌曲</small></span>{added === playlist.id ? <Check size={17} /> : <ListPlus size={17} />}</button>)}{playlists.data?.length === 0 && <small>请先在左侧创建歌单</small>}</div></div></div>
}

function LibraryEmpty({ title, detail, spinning }: { title: string; detail: string; spinning?: boolean }) {
  return <div className="library-empty"><span><Library className={spinning ? 'spin' : ''} /></span><h3>{title}</h3><p>{detail}</p></div>
}

export function MetadataDialog({ track, onClose, onSaved }: { track: Track; onClose: () => void; onSaved: (track: Track) => void }) {
  const [title, setTitle] = useState(track.title)
  const [artist, setArtist] = useState(track.artist || '')
  const [album, setAlbum] = useState(track.album || '')
  const [coverUrl, setCoverUrl] = useState(track.coverUrl || '')
  const [catalog, setCatalog] = useState<CatalogCandidate[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [searchTitle, setSearchTitle] = useState(title)
  const [searchArtist, setSearchArtist] = useState(artist)
  const [catalogSource, setCatalogSource] = useState<CatalogSource>('auto')
  const mutation = useMutation({ mutationFn: () => updateStoredMetadata(track.id, { title, artist, album, coverUrl }), onSuccess: onSaved })
  const submit = (event: FormEvent) => { event.preventDefault(); if (title.trim()) mutation.mutate() }
  const enrich = async (lookupTitle = searchTitle, lookupArtist = searchArtist, source = catalogSource) => {
    setCatalogOpen(true)
    if (!lookupTitle.trim()) { setCatalogError('请填写用于搜索的歌曲名'); return }
    setCatalogLoading(true); setCatalogError(''); setCatalog([])
    try { const results = await searchMetadataCatalog(lookupTitle.trim(), lookupArtist.trim(), source); setCatalog(results); if (!results.length) setCatalogError('没有匹配结果，可以调整搜索信息或切换来源') }
    catch (cause) { setCatalogError(commandErrorMessage(cause)) }
    finally { setCatalogLoading(false) }
  }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <form className="metadata-dialog" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="metadata-title">
      <header><div><span className="eyebrow">TRACK DETAILS</span><h3 id="metadata-title">编辑歌曲信息</h3></div><button type="button" onClick={onClose} aria-label="关闭"><X /></button></header>
      <div className="metadata-preview">{coverUrl ? <img src={coverUrl} alt="封面预览" /> : <span /> }<div><strong>{title || '歌曲名'}</strong><small>{artist || '歌手未知'}</small></div></div>
      <label>歌曲名<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
      <div className="field-pair"><label>歌手<input value={artist} onChange={(event) => setArtist(event.target.value)} placeholder="歌手未知" /></label><label>专辑<input value={album} onChange={(event) => setAlbum(event.target.value)} placeholder="可选" /></label></div>
      <label>封面地址<input value={coverUrl} onChange={(event) => setCoverUrl(event.target.value)} placeholder="https://" /></label>
      <button className="metadata-enrich" type="button" disabled={catalogLoading} onClick={() => { setSearchTitle(title); setSearchArtist(artist); void enrich(title, artist) }}>{catalogLoading ? <LoaderCircle className="spin" /> : <Sparkles />}{catalogLoading ? '正在匹配…' : '匹配歌曲信息'}</button>
      {catalogOpen && <div className="metadata-search-panel"><p>选择结果后再保存，也可以调整关键词或切换来源。</p><div className="field-pair"><label>搜索歌曲名<input aria-label="匹配搜索歌曲名" value={searchTitle} onChange={(event) => setSearchTitle(event.target.value)} /></label><label>搜索歌手<input aria-label="匹配搜索歌手" value={searchArtist} onChange={(event) => setSearchArtist(event.target.value)} placeholder="可选" /></label></div><label>资料来源<select aria-label="歌曲信息来源" value={catalogSource} disabled={catalogLoading} onChange={event => { const source = event.target.value as CatalogSource; setCatalogSource(source); void enrich(searchTitle, searchArtist, source) }}><option value="auto">自动 · 优先 iTunes 华语曲库</option><option value="itunes">iTunes · 台湾 / 香港 / 美国</option><option value="musicbrainz">MusicBrainz / Cover Art Archive</option></select></label><button type="button" className="metadata-enrich" onClick={() => void enrich()} disabled={catalogLoading}>重新搜索</button></div>}
      {catalogError && <div className="dialog-error">{catalogError}</div>}
      {catalog.length > 0 && <div className="catalog-results">{catalog.map((item) => <button type="button" key={item.trackId} onClick={() => { setTitle(item.trackName); setArtist(item.artistName); if (item.collectionName) setAlbum(item.collectionName); if (item.artworkUrl) setCoverUrl(item.artworkUrl); setCatalog([]); setCatalogOpen(false) }}><Artwork src={item.artworkUrl} /><span><strong>{item.trackName} · {item.artistName}</strong><small>{item.collectionName || '专辑未知'} · {item.source}</small></span></button>)}</div>}
      {mutation.isError && <div className="dialog-error">{commandErrorMessage(mutation.error)}</div>}
      <footer><button type="button" onClick={onClose}>取消</button><button className="save-button" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15} /> : null}保存修改</button></footer>
    </form>
  </div>
}
