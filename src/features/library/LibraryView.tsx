import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Download, Heart, Library, ListPlus, LoaderCircle, Pencil, Play, Sparkles, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { Track } from '../../domain/track'
import { addTrackToPlaylist, commandErrorMessage, deletePlaylist, downloadTrack, listLibraryTracks, listPlaylists, listPlaylistTracks, listRecentTracks, removeTrackFromPlaylist, renamePlaylist, searchMetadataCatalog, toggleStoredFavorite, updateStoredMetadata, type CatalogCandidate, type Playlist } from '../../services/desktopApi'
import { chooseDownloadDirectory, getDownloadDirectory } from '../../services/settings'
import { formatDuration } from '../../shared/time'
import { usePlayerStore } from '../player/playerStore'

export function LibraryView({ favoritesOnly = false, recent = false, playlist, onPlaylistDeleted }: { favoritesOnly?: boolean; recent?: boolean; playlist?: Playlist; onPlaylistDeleted?: () => void }) {
  const client = useQueryClient()
  const play = usePlayerStore((state) => state.play)
  const playAll = usePlayerStore((state) => state.playAll)
  const enqueue = usePlayerStore((state) => state.enqueue)
  const updatePlayerTrack = usePlayerStore((state) => state.updateTrack)
  const [editing, setEditing] = useState<Track | null>(null)
  const [adding, setAdding] = useState<Track | null>(null)
  const [downloadMessage, setDownloadMessage] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const tracks = useQuery({ queryKey: ['library', favoritesOnly, recent, playlist?.id], queryFn: () => playlist ? listPlaylistTracks(playlist.id) : recent ? listRecentTracks() : listLibraryTracks(favoritesOnly) })
  const favorite = useMutation({
    mutationFn: toggleStoredFavorite,
    onSuccess: (liked, id) => { const track = tracks.data?.find((item) => item.id === id); if (track) updatePlayerTrack({ ...track, liked }); return client.invalidateQueries({ queryKey: ['library'] }) },
  })
  const managePlaylist = useMutation({ mutationFn: async (action: 'rename' | 'delete') => { if (!playlist) return; if (action === 'rename') await renamePlaylist(playlist.id, name); else await deletePlaylist(playlist.id); return action }, onSuccess: (action) => { setRenaming(false); setConfirmDelete(false); void client.invalidateQueries({ queryKey: ['playlists'] }); if (action === 'delete') onPlaylistDeleted?.() } })
  const startDownload = async (track: Track) => {
    try {
      let directory = await getDownloadDirectory()
      if (!directory) directory = await chooseDownloadDirectory()
      if (!directory) return
      setDownloadMessage(`正在下载「${track.title}」`)
      await downloadTrack(track, directory)
      setDownloadMessage(`「${track.title}」下载完成`)
      await client.invalidateQueries({ queryKey: ['downloads'] })
    } catch (cause) { setDownloadMessage(commandErrorMessage(cause)) }
  }

  return <section className="library-view">
    <header><div><span className="eyebrow">YOUR COLLECTION</span><h2>{playlist?.name || (recent ? '最近播放' : favoritesOnly ? '我喜欢' : '音乐库')}</h2><p>{playlist ? `${playlist.trackCount} 首歌曲 · 本地歌单` : recent ? '按最近一次播放整理，继续上次的声音。' : favoritesOnly ? '只属于你的声音标记。' : '播放过的歌曲会自动整理到这里。'}</p></div></header>
    <div className="collection-actions"><button disabled={!tracks.data?.length} onClick={() => void playAll(tracks.data || [])}><Play size={16} />播放全部</button><button disabled={!tracks.data?.length} onClick={() => enqueue(tracks.data || [])}><ListPlus size={16} />全部加入队列</button>{playlist && <><button onClick={() => { setName(playlist.name); setRenaming(true) }}><Pencil size={15} />重命名</button><button onClick={() => setConfirmDelete(true)}><Trash2 size={15} />删除歌单</button></>}</div>
    {(renaming || confirmDelete) && <form className="playlist-management" onSubmit={(event) => { event.preventDefault(); managePlaylist.mutate(renaming ? 'rename' : 'delete') }}>{renaming ? <input autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} aria-label="歌单名称" /> : <span>删除「{playlist?.name}」？歌曲仍会保留在音乐库中。</span>}<button disabled={managePlaylist.isPending || (renaming && !name.trim())}>确认</button><button type="button" onClick={() => { setRenaming(false); setConfirmDelete(false) }}>取消</button></form>}
    {managePlaylist.isError && <p className="inline-error">{commandErrorMessage(managePlaylist.error)}</p>}
    {favorite.isError && <p className="inline-error">{commandErrorMessage(favorite.error)}</p>}
    {tracks.isLoading && <LibraryEmpty spinning title="正在读取资料库" detail="本地数据库正在准备歌曲信息" />}
    {tracks.isError && <LibraryEmpty title="资料库读取失败" detail={commandErrorMessage(tracks.error)} />}
    {tracks.data?.length === 0 && <LibraryEmpty title={playlist ? '歌单还是空的' : recent ? '还没有播放记录' : favoritesOnly ? '还没有喜欢的歌曲' : '音乐库还是空的'} detail={playlist ? '在音乐库的歌曲菜单中把歌曲加入这里。' : '从搜索结果播放歌曲后，它会自动出现在这里。'} />}
    {Boolean(tracks.data?.length) && <div className="library-grid">{tracks.data!.map((track, index) => <article className="library-track" key={track.id}>
      <button className="library-art" onClick={() => void play(track)} aria-label={`播放 ${track.title}`}>
        {track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" /> : <span className={`tone-${index % 4}`} />}
        <i><Play fill="currentColor" /></i>
      </button>
      <div className="library-copy"><strong>{track.title}</strong><small>{track.artist || '歌手未知'}{track.album ? ` · ${track.album}` : ''}</small></div>
      <span className="library-duration">{formatDuration(track.durationSeconds)}</span>
      <button className={track.liked ? 'icon-action liked' : 'icon-action'} onClick={() => favorite.mutate(track.id)} aria-label={track.liked ? '取消喜欢' : '添加喜欢'}><Heart size={17} fill={track.liked ? 'currentColor' : 'none'} /></button>
      <button className="icon-action" onClick={() => setEditing(track)} aria-label="编辑歌曲信息"><Pencil size={16} /></button>
      <button className="icon-action" onClick={() => enqueue([track])} aria-label="加入播放队列"><ListPlus size={16} /></button>
      <button className="icon-action" onClick={() => void startDownload(track)} aria-label="下载歌曲"><Download size={16} /></button>
      {playlist ? <button className="icon-action" onClick={() => void removeTrackFromPlaylist(playlist.id, track.id).then(async () => { await client.invalidateQueries({ queryKey: ['library'] }); await client.invalidateQueries({ queryKey: ['playlists'] }) }).catch((error) => setDownloadMessage(commandErrorMessage(error)))} aria-label="从歌单移除"><Trash2 size={16} /></button> : <button className="icon-action" onClick={() => setAdding(track)} aria-label="添加到歌单"><ListPlus size={17} /></button>}
    </article>)}</div>}
    {editing && <MetadataDialog track={editing} onClose={() => setEditing(null)} onSaved={(updated) => { updatePlayerTrack(updated); setEditing(null); void client.invalidateQueries({ queryKey: ['library'] }); void client.invalidateQueries({ queryKey: ['home-recent'] }) }} />}
    {adding && <PlaylistPicker track={adding} onClose={() => setAdding(null)} />}
    {downloadMessage && <button className="library-toast" onClick={() => setDownloadMessage('')}>{downloadMessage}</button>}
  </section>
}

function PlaylistPicker({ track, onClose }: { track: Track; onClose: () => void }) {
  const client = useQueryClient()
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: listPlaylists })
  const [added, setAdded] = useState<string | null>(null)
  const [error, setError] = useState('')
  const add = async (playlistId: string) => {
    try {
    await addTrackToPlaylist(playlistId, track.id)
    setAdded(playlistId)
    await client.invalidateQueries({ queryKey: ['playlists'] })
    await client.invalidateQueries({ queryKey: ['library'] })
    } catch (cause) { setError(commandErrorMessage(cause)) }
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="playlist-picker" role="dialog" aria-modal="true"><header><div><span className="eyebrow">PLAYLIST</span><h3>添加到歌单</h3></div><button onClick={onClose}><X /></button></header><p>{track.title}</p>{error && <p className="inline-error">{error}</p>}<div>{playlists.data?.map((playlist) => <button key={playlist.id} onClick={() => void add(playlist.id)}><span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首歌曲</small></span>{added === playlist.id ? <Check size={17} /> : <ListPlus size={17} />}</button>)}{playlists.data?.length === 0 && <small>请先在左侧创建歌单</small>}</div></div></div>
}

function LibraryEmpty({ title, detail, spinning }: { title: string; detail: string; spinning?: boolean }) {
  return <div className="library-empty"><span><Library className={spinning ? 'spin' : ''} /></span><h3>{title}</h3><p>{detail}</p></div>
}

function MetadataDialog({ track, onClose, onSaved }: { track: Track; onClose: () => void; onSaved: (track: Track) => void }) {
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
