import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Heart, Library, LoaderCircle, MoreHorizontal, Pencil, Play, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { Track } from '../../domain/track'
import { commandErrorMessage, listLibraryTracks, listRecentTracks, toggleStoredFavorite, updateStoredMetadata } from '../../services/desktopApi'
import { formatDuration } from '../../shared/time'
import { usePlayerStore } from '../player/playerStore'

export function LibraryView({ favoritesOnly = false, recent = false }: { favoritesOnly?: boolean; recent?: boolean }) {
  const client = useQueryClient()
  const play = usePlayerStore((state) => state.play)
  const [editing, setEditing] = useState<Track | null>(null)
  const tracks = useQuery({ queryKey: ['library', favoritesOnly, recent], queryFn: () => recent ? listRecentTracks() : listLibraryTracks(favoritesOnly) })
  const favorite = useMutation({
    mutationFn: toggleStoredFavorite,
    onSuccess: () => client.invalidateQueries({ queryKey: ['library'] }),
  })

  return <section className="library-view">
    <header><div><span className="eyebrow">YOUR COLLECTION</span><h2>{recent ? '最近播放' : favoritesOnly ? '我喜欢' : '音乐库'}</h2><p>{recent ? '按最近一次播放整理，继续上次的声音。' : favoritesOnly ? '只属于你的声音标记。' : '播放过的歌曲会自动整理到这里。'}</p></div></header>
    {tracks.isLoading && <LibraryEmpty spinning title="正在读取资料库" detail="本地数据库正在准备歌曲信息" />}
    {tracks.isError && <LibraryEmpty title="资料库读取失败" detail={commandErrorMessage(tracks.error)} />}
    {tracks.data?.length === 0 && <LibraryEmpty title={recent ? '还没有播放记录' : favoritesOnly ? '还没有喜欢的歌曲' : '音乐库还是空的'} detail="从搜索结果播放歌曲后，它会自动出现在这里。" />}
    {Boolean(tracks.data?.length) && <div className="library-grid">{tracks.data!.map((track, index) => <article className="library-track" key={track.id}>
      <button className="library-art" onClick={() => void play(track)} aria-label={`播放 ${track.title}`}>
        {track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" /> : <span className={`tone-${index % 4}`} />}
        <i><Play fill="currentColor" /></i>
      </button>
      <div className="library-copy"><strong>{track.title}</strong><small>{track.artist || '歌手未知'}{track.album ? ` · ${track.album}` : ''}</small></div>
      <span className="library-duration">{formatDuration(track.durationSeconds)}</span>
      <button className={track.liked ? 'icon-action liked' : 'icon-action'} onClick={() => favorite.mutate(track.id)} aria-label={track.liked ? '取消喜欢' : '添加喜欢'}><Heart size={17} fill={track.liked ? 'currentColor' : 'none'} /></button>
      <button className="icon-action" onClick={() => setEditing(track)} aria-label="编辑歌曲信息"><Pencil size={16} /></button>
      <button className="icon-action" aria-label="更多操作"><MoreHorizontal size={18} /></button>
    </article>)}</div>}
    {editing && <MetadataDialog track={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); client.invalidateQueries({ queryKey: ['library'] }) }} />}
  </section>
}

function LibraryEmpty({ title, detail, spinning }: { title: string; detail: string; spinning?: boolean }) {
  return <div className="library-empty"><span><Library className={spinning ? 'spin' : ''} /></span><h3>{title}</h3><p>{detail}</p></div>
}

function MetadataDialog({ track, onClose, onSaved }: { track: Track; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(track.title)
  const [artist, setArtist] = useState(track.artist || '')
  const [album, setAlbum] = useState(track.album || '')
  const [coverUrl, setCoverUrl] = useState(track.coverUrl || '')
  const mutation = useMutation({ mutationFn: () => updateStoredMetadata(track.id, { title, artist, album, coverUrl }), onSuccess: onSaved })
  const submit = (event: FormEvent) => { event.preventDefault(); if (title.trim()) mutation.mutate() }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <form className="metadata-dialog" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="metadata-title">
      <header><div><span className="eyebrow">TRACK DETAILS</span><h3 id="metadata-title">编辑歌曲信息</h3></div><button type="button" onClick={onClose} aria-label="关闭"><X /></button></header>
      <div className="metadata-preview">{coverUrl ? <img src={coverUrl} alt="封面预览" /> : <span /> }<div><strong>{title || '歌曲名'}</strong><small>{artist || '歌手未知'}</small></div></div>
      <label>歌曲名<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
      <div className="field-pair"><label>歌手<input value={artist} onChange={(event) => setArtist(event.target.value)} placeholder="歌手未知" /></label><label>专辑<input value={album} onChange={(event) => setAlbum(event.target.value)} placeholder="可选" /></label></div>
      <label>封面地址<input value={coverUrl} onChange={(event) => setCoverUrl(event.target.value)} placeholder="https://" /></label>
      {mutation.isError && <div className="dialog-error">{commandErrorMessage(mutation.error)}</div>}
      <footer><button type="button" onClick={onClose}>取消</button><button className="save-button" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15} /> : null}保存修改</button></footer>
    </form>
  </div>
}
