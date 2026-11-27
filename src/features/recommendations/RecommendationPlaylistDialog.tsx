import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Library, Link2, ListPlus, LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Playlist } from '../../domain/library'
import { folderPlayableTracks, recommendationPlaylistName } from '../../domain/recommendation'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage } from '../../services/userErrors'
import { FAVORITES_PLAYLIST_ID, listPlaylists } from '../../services/desktopApi'
import { accountQueryKey } from '../../services/queryKeys'
import { linkedFolderKey } from '../../services/linkedFolders'
import {
  addRecommendationTracksToPlaylist,
  RecommendationPlaylistPartialError,
  saveRecommendationPlaylist,
  type RecommendationPlaylistWrite,
} from '../../services/recommendations'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { usePlayerStore } from '../player/playerStore'

const PLAYLIST_NAME_MAX = 80
const LINKED_NAME_MAX = 40

/**
 * Turns today's matched songs into a playlist. The tracks are the bindings the
 * matching lane already stored, so this never searches Bilibili again.
 */
export function RecommendationPlaylistDialog({ day, sourceName, tracks, onClose }: {
  day: string
  sourceName: string
  tracks: Track[]
  onClose: () => void
}) {
  const client = useQueryClient()
  const playlists = useQuery({ queryKey: accountQueryKey('playlists'), queryFn: listPlaylists })
  const [name, setName] = useState(() => recommendationPlaylistName(day))
  const [linked, setLinked] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<RecommendationPlaylistWrite>()
  const [partial, setPartial] = useState<{ playlist: Playlist; added: number; message: string }>()
  const epoch = useRef(accountEpoch()).current
  const folder = folderPlayableTracks(tracks)
  const folderBlocked = (playlist: Playlist) => Boolean(playlist.biliFolderId) && !folder.included.length
  const folderNote = (playlist: Playlist) => {
    if (!playlist.biliFolderId) return ''
    if (!folder.included.length) return ' · 无可加入的单 P 视频'
    return folder.skipped > 0 ? ` · 将跳过 ${folder.skipped} 首多 P 视频` : ''
  }
  // The dock heart reads the player store; writing 我喜欢 without this leaves
  // it hollow until the next playback.
  const markLiked = (playlistId: string) => {
    if (playlistId !== FAVORITES_PLAYLIST_ID) return
    const store = usePlayerStore.getState()
    for (const track of tracks) store.updateTrack({ ...track, liked: true })
  }

  const write = async (run: () => Promise<RecommendationPlaylistWrite>) => {
    if (pending) return
    if (epoch !== accountEpoch()) { setError('B 站账号已切换，请关闭后重试'); return }
    setPending(true)
    setError('')
    try {
      const result = await run()
      setDone(result)
      setPartial(undefined)
      if (result.folderId) void client.invalidateQueries({ queryKey: linkedFolderKey(result.folderId) })
      await Promise.all(['playlists', 'library', 'home-recent'].map(key => client.invalidateQueries({ queryKey: [key] })))
    } catch (cause) {
      if (epoch !== accountEpoch()) { setError('B 站账号已切换，写入已中止'); return }
      if (cause instanceof RecommendationPlaylistPartialError) {
        setPartial({ playlist: cause.playlist, added: cause.added, message: commandErrorMessage(cause.reason) })
        if (cause.playlist.biliFolderId) void client.invalidateQueries({ queryKey: linkedFolderKey(cause.playlist.biliFolderId) })
        return
      }
      setError(commandErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  const create = () => {
    const trimmed = name.trim()
    if (!trimmed) { setError('请填写歌单名称'); return }
    if (trimmed.length > (linked ? LINKED_NAME_MAX : PLAYLIST_NAME_MAX)) { setError(`名称不能超过 ${linked ? LINKED_NAME_MAX : PLAYLIST_NAME_MAX} 个字符`); return }
    void write(() => saveRecommendationPlaylist(trimmed, tracks, linked))
  }
  const retryPartial = () => {
    if (!partial) return
    void write(() => addRecommendationTracksToPlaylist(partial.playlist, tracks))
  }
  const append = (playlist: Playlist) => void write(async () => {
    const result = await addRecommendationTracksToPlaylist(playlist, tracks)
    markLiked(playlist.id)
    return result
  })

  if (done) {
    return <CollectionDialog title="添加为歌单" mobileSheet className="recommendation-dialog recommendation-playlist-dialog" onClose={onClose}>
      <div className="recommendation-dialog-body">
        <p className="recommendation-playlist-done" role="status"><Check size={17} />已添加到「{done.playlistName}」，共提交 {done.added} 首</p>
        {done.skipped > 0 && <p className="recommendation-playlist-note">{done.skipped} 首来自多 P 视频或重复视频，B 站收藏夹只能收录整部单 P 视频，已跳过。</p>}
        <div className="recommendation-dialog-footer"><button type="button" className="recommendation-primary" onClick={onClose}>完成</button></div>
      </div>
    </CollectionDialog>
  }

  if (partial) {
    return <CollectionDialog title="添加为歌单" mobileSheet className="recommendation-dialog recommendation-playlist-dialog" onClose={onClose}>
      <div className="recommendation-dialog-body">
        <p className="recommendation-playlist-done" role="status"><Check size={17} />歌单「{partial.playlist.name}」已创建，已加入 {partial.added} 首</p>
        <p className="recommendation-dialog-error" role="alert">后面的歌曲没有全部加入：{partial.message}</p>
        {partial.added === 0 && <p className="recommendation-playlist-note">可以重试加入，不会重复创建歌单。</p>}
        <div className="recommendation-dialog-footer">
          <button type="button" disabled={pending} onClick={onClose}>完成</button>
          <button type="button" className="recommendation-primary" disabled={pending} onClick={retryPartial}>
            {pending ? <LoaderCircle size={15} className="spin" /> : <ListPlus size={15} />}重试加入
          </button>
        </div>
      </div>
    </CollectionDialog>
  }

  if (!tracks.length) {
    return <CollectionDialog title="添加为歌单" mobileSheet className="recommendation-dialog recommendation-playlist-dialog" onClose={onClose}>
      <div className="recommendation-dialog-body">
        <p className="recommendation-dialog-empty">今天的歌曲还没有匹配到 B 站视频，暂时不能添加为歌单。</p>
        <div className="recommendation-dialog-footer"><button type="button" onClick={onClose}>关闭</button></div>
      </div>
    </CollectionDialog>
  }

  return <CollectionDialog title="添加为歌单" mobileSheet className="recommendation-dialog recommendation-playlist-dialog" onClose={onClose}>
    <div className="recommendation-dialog-body">
      <p className="recommendation-dialog-empty">把「{sourceName}」今天的 {tracks.length} 首已匹配歌曲保存成歌单。未匹配的歌曲不会被加入。</p>
      <form className="recommendation-playlist-create" onSubmit={event => { event.preventDefault(); create() }}>
        <label>
          <span>歌单名称</span>
          <input autoFocus data-dialog-autofocus aria-label="歌单名称" maxLength={linked ? LINKED_NAME_MAX : PLAYLIST_NAME_MAX} value={name} disabled={pending}
            onChange={event => setName(event.target.value)} placeholder="歌单名称" />
        </label>
        <div className="recommendation-destination-toggle" role="radiogroup" aria-label="歌单类型">
          <button type="button" role="radio" aria-checked={!linked} disabled={pending} onClick={() => setLinked(false)}>
            <Library size={16} /><span><strong>本地歌单</strong><small>保存在本机，任意分 P</small></span>
          </button>
          <button type="button" role="radio" aria-checked={linked} disabled={pending}
            onClick={() => { setLinked(true); setName(value => value.slice(0, LINKED_NAME_MAX)) }}>
            <Link2 size={16} /><span><strong>B 站收藏夹</strong><small>同步到 B 站，仅单 P 视频</small></span>
          </button>
        </div>
        {linked && folder.skipped > 0 && <p className="recommendation-playlist-note">{folder.included.length
          ? `有 ${folder.skipped} 首来自多 P 视频或重复视频，B 站收藏夹只能收录整部单 P 视频，将跳过。`
          : '今天的匹配都来自多 P 视频，B 站收藏夹只能收录整部单 P 视频，无法添加。'}</p>}
        <button type="submit" className="recommendation-primary" disabled={pending || !name.trim() || linked && !folder.included.length}>
          {pending ? <LoaderCircle size={15} className="spin" /> : <ListPlus size={15} />}创建并添加
        </button>
      </form>

      <div className="recommendation-playlist-existing">
        <p className="recommendation-playlist-heading">或添加到已有歌单</p>
        {playlists.isPending ? <p role="status" className="recommendation-playlist-note"><LoaderCircle size={14} className="spin" />正在读取歌单…</p>
          : playlists.isError ? <p className="recommendation-dialog-error" role="alert">读取歌单失败：{commandErrorMessage(playlists.error)}
            <button type="button" className="recommendation-retry" disabled={pending} onClick={() => void playlists.refetch()}>重试</button></p>
          : playlists.data?.length ? <div className="playlist-destinations">
            {playlists.data.map(playlist => <button key={playlist.id} type="button" disabled={pending || folderBlocked(playlist)} onClick={() => append(playlist)}>
              <span className="playlist-destination-art">{playlist.biliFolderId ? <Link2 size={20} /> : <Library size={20} />}</span>
              <span>
                <strong>{playlist.name}</strong>
                <small>{playlist.trackCount} {playlist.biliFolderId ? '个视频 · B 站同步' : '首歌曲'}{folderNote(playlist)}</small>
              </span>
              <ListPlus size={18} />
            </button>)}
          </div>
          : <p className="recommendation-playlist-note">还没有歌单，可以在上面新建一个。</p>}
      </div>

      {/* The footer is sticky and opaque, so the status line lives inside it;
          rendered above it, the error was covered by the pinned footer. */}
      <div className="recommendation-dialog-footer recommendation-playlist-footer">
        {error && <p className="recommendation-dialog-error" role="alert">{error}</p>}
        {pending && <p className="recommendation-playlist-note" role="status"><LoaderCircle size={14} className="spin" />正在添加，请稍候…</p>}
        <button type="button" disabled={pending} onClick={onClose}>取消</button>
      </div>
    </div>
  </CollectionDialog>
}
