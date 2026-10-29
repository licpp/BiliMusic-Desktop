import { TrackMenuButton } from './TrackActions'
import { DownloadsView } from '../downloads/DownloadsView'
import { hydrateVisibleTracks } from '../../services/sync'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Download, Heart, Library, ListPlus, LoaderCircle, Pencil, Play, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { Track } from '../../domain/track'
import { addTrackToPlaylist, commandErrorMessage, deletePlaylist, downloadTrack, FAVORITES_PLAYLIST_ID, listLibraryTracks, listPlaylists, listPlaylistTracks, listRecentTracks, removeTrackFromPlaylist, renamePlaylist, saveLibraryTrack, searchMetadataCatalog, toggleStoredFavorite, updateStoredMetadata, type CatalogCandidate, type Playlist } from '../../services/desktopApi'
import { showTrackMenu } from './trackActionStore'
import { chooseDownloadDirectory, getDownloadDirectory } from '../../services/settings'
import { formatDuration } from '../../shared/time'
import { usePlayerStore } from '../player/playerStore'

export type LibraryTab = 'saved' | 'recent' | 'downloads'
export function MusicLibraryView({ tab, onTabChange }: { tab: LibraryTab; onTabChange: (tab: LibraryTab) => void }) {
  const tabs: [LibraryTab,string][] = [['saved','已收藏'],['recent','最近播放'],['downloads','下载']]
  return <div className="music-library"><div className="library-tabs" role="tablist" aria-label="音乐库视图" onKeyDown={e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const i=tabs.findIndex(t=>t[0]===tab);const next=tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length][0];onTabChange(next);e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()}}>{tabs.map(([id,label])=><button id={`library-tab-${id}`} key={id} role="tab" data-tab={id} aria-selected={tab===id} tabIndex={tab===id?0:-1} aria-controls="music-library-panel" onClick={()=>onTabChange(id)}>{label}</button>)}</div><div id="music-library-panel" role="tabpanel" aria-labelledby={`library-tab-${tab}`}>{tab==='downloads' ? <DownloadsView /> : <LibraryView recent={tab==='recent'} />}</div></div>
}

export function LibraryView({ recent = false, playlist, onPlaylistDeleted }: { recent?: boolean; playlist?: Playlist; onPlaylistDeleted?: () => void }) {
  const client = useQueryClient()
  const play = usePlayerStore((state) => state.play)
  const playAll = usePlayerStore((state) => state.playAll)
  const enqueue = usePlayerStore((state) => state.enqueue)
  const updatePlayerTrack = usePlayerStore((state) => state.updateTrack)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const tracks = useQuery({ queryKey: ['library', recent ? 'recent' : 'saved', playlist?.id], queryFn: () => playlist ? listPlaylistTracks(playlist.id) : recent ? listRecentTracks() : listLibraryTracks(false, true) })
  useEffect(() => { void hydrateVisibleTracks(tracks.data, client).catch(() => undefined) }, [tracks.data, client])
  const isFavorites = playlist?.id === FAVORITES_PLAYLIST_ID
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['library'] }), client.invalidateQueries({ queryKey: ['playlists'] }), client.invalidateQueries({ queryKey: ['home-recent'] })])
  const favorite = useMutation({
    mutationFn: toggleStoredFavorite,
    onSuccess: (liked, id) => { const track = tracks.data?.find((item) => item.id === id); if (track) updatePlayerTrack({ ...track, liked }); return refresh() },
  })
  const managePlaylist = useMutation({ mutationFn: async (action: 'rename' | 'delete') => { if (!playlist || playlist.isSystem) return; if (action === 'rename') await renamePlaylist(playlist.id, name); else await deletePlaylist(playlist.id); return action }, onSuccess: (action) => { setRenaming(false); setConfirmDelete(false); void refresh(); if (action === 'delete') onPlaylistDeleted?.() } })


  return <section className="library-view">
    <header><div><span className="eyebrow">YOUR COLLECTION</span><h2>{playlist?.name || '音乐库'}</h2><p>{playlist ? `${playlist.trackCount} 首歌曲 · ${playlist.isSystem ? '默认歌单，点击红心即可收藏或取消喜欢。' : '本地歌单'}` : recent ? '按最近一次播放整理，播放历史不会自动加入收藏。' : '收藏喜欢的歌曲，或将歌曲加入歌单，统一整理在这里。'}</p></div></header>

    <div className="collection-actions"><button disabled={!tracks.data?.length} onClick={() => void playAll(tracks.data || [])}><Play size={16} />播放全部</button><button disabled={!tracks.data?.length} onClick={() => enqueue(tracks.data || [])}><ListPlus size={16} />全部加入队列</button>{playlist && !playlist.isSystem && <><button onClick={() => { setName(playlist.name); setRenaming(true) }}><Pencil size={15} />重命名</button><button onClick={() => setConfirmDelete(true)}><Trash2 size={15} />删除歌单</button></>}</div>
    {(renaming || confirmDelete) && <form className="playlist-management" onSubmit={(event) => { event.preventDefault(); managePlaylist.mutate(renaming ? 'rename' : 'delete') }}>{renaming ? <input autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} aria-label="歌单名称" /> : <span>删除「{playlist?.name}」？仅删除此歌单，保留歌曲信息、播放记录和其他歌单。</span>}<button disabled={managePlaylist.isPending || (renaming && !name.trim())}>确认</button><button type="button" onClick={() => { setRenaming(false); setConfirmDelete(false) }}>取消</button></form>}
    {managePlaylist.isError && <p className="inline-error">{commandErrorMessage(managePlaylist.error)}</p>}
    {favorite.isError && <p className="inline-error">{commandErrorMessage(favorite.error)}</p>}
    <div>
    {tracks.isLoading && <LibraryEmpty spinning title="正在读取资料库" detail="本地数据库正在准备歌曲信息" />}
    {tracks.isError && <LibraryEmpty title="资料库读取失败" detail={commandErrorMessage(tracks.error)} />}
    {tracks.data?.length === 0 && <LibraryEmpty title={isFavorites ? '还没有喜欢的歌曲' : playlist ? '歌单还是空的' : recent ? '还没有播放记录' : '还没有收藏的歌曲'} detail={isFavorites ? '点击歌曲旁的红心，或通过“加入歌单”添加到我喜欢。' : playlist ? '通过歌曲菜单把歌曲加入这里。' : recent ? '播放过的歌曲会出现在这里。' : '点击红心，或把歌曲加入歌单后，它会出现在这里。'} />}
    {Boolean(tracks.data?.length) && <div className="library-grid">{tracks.data!.map((track, index) => <article className="library-track" key={track.id} onContextMenu={(event) => showTrackMenu(event, track, playlist?.id)}>
      <button className="library-art" onClick={() => void play(track)} aria-label={`播放 ${track.title}`}>
        {track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" /> : <span className={`tone-${index % 4}`} />}
        <i><Play fill="currentColor" /></i>
      </button>
      <div className="library-copy"><strong>{track.title}</strong><small>{track.artist || '歌手未知'}{track.album ? ` · ${track.album}` : ''}</small></div>
      <span className="library-duration">{formatDuration(track.durationSeconds)}</span>
      <div className="library-track-actions">
      <button className={track.liked ? 'icon-action liked' : 'icon-action'} onClick={() => favorite.mutate(track.id)} aria-label={track.liked ? '取消喜欢' : '添加喜欢'}><Heart size={17} fill={track.liked ? 'currentColor' : 'none'} /></button>
      <TrackMenuButton track={track} playlistId={playlist?.id} />
      </div>
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
  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="playlist-picker" role="dialog" aria-modal="true"><header><div><span className="eyebrow">PLAYLIST</span><h3>添加到歌单</h3></div><button onClick={onClose}><X /></button></header><p>{tracks.length === 1 ? tracks[0].title : `共 ${tracks.length} 首歌曲`}</p>{error && <p className="inline-error">{error}</p>}<div>{playlists.data?.map((playlist) => <button key={playlist.id} disabled={pending} onClick={() => void add(playlist.id)}><span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首歌曲</small></span>{added === playlist.id ? <Check size={17} /> : <ListPlus size={17} />}</button>)}{playlists.data?.length === 0 && <small>请先在左侧创建歌单</small>}</div></div></div>
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
  const mutation = useMutation({ mutationFn: () => updateStoredMetadata(track.id, { title, artist, album, coverUrl }), onSuccess: onSaved })
  const submit = (event: FormEvent) => { event.preventDefault(); if (title.trim()) mutation.mutate() }
  const enrich = async () => {
    if (!searchTitle.trim() || !searchArtist.trim()) { setCatalogError('请填写用于搜索的歌曲名和歌手'); return }
    setCatalogLoading(true); setCatalogError('')
    try { const results = await searchMetadataCatalog(searchTitle, searchArtist); setCatalog(results); if (!results.length) setCatalogError('没有匹配结果，请调整搜索信息') }
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
      <button className="metadata-enrich" type="button" onClick={() => { setSearchTitle(title); setSearchArtist(artist); setCatalogOpen((value) => !value) }}><Sparkles />匹配歌曲信息</button>
      {catalogOpen && <div className="metadata-search-panel"><p>修改搜索信息，选择结果后再保存。</p><div className="field-pair"><label>搜索歌曲名<input aria-label="匹配搜索歌曲名" value={searchTitle} onChange={(event) => setSearchTitle(event.target.value)} /></label><label>搜索歌手<input aria-label="匹配搜索歌手" value={searchArtist} onChange={(event) => setSearchArtist(event.target.value)} /></label></div><button type="button" className="metadata-enrich" onClick={() => void enrich()} disabled={catalogLoading}>{catalogLoading && <LoaderCircle className="spin" />}搜索歌曲信息</button></div>}
      {catalogError && <div className="dialog-error">{catalogError}</div>}
      {catalog.length > 0 && <div className="catalog-results">{catalog.map((item) => <button type="button" key={item.trackId} onClick={() => { setTitle(item.trackName); setArtist(item.artistName); setAlbum(item.collectionName || ''); setCoverUrl(item.artworkUrl || ''); setCatalog([]); setCatalogOpen(false) }}>{item.artworkUrl ? <img src={item.artworkUrl} alt="" /> : <span />}<span><strong>{item.trackName} · {item.artistName}</strong><small>{item.collectionName || '专辑未知'}</small></span></button>)}</div>}
      {mutation.isError && <div className="dialog-error">{commandErrorMessage(mutation.error)}</div>}
      <footer><button type="button" onClick={onClose}>取消</button><button className="save-button" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15} /> : null}保存修改</button></footer>
    </form>
  </div>
}
