import { accountQueryKey, accountKeyAt } from '../../services/queryKeys'
import { useQuery,useQueryClient } from '@tanstack/react-query'
import { Check,Library,Link2,ListPlus,LoaderCircle } from 'lucide-react'
import { useRef,useState } from 'react'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { toTrack } from '../../services/collectionTrack'
import { addTracksToPlaylist, changeLinkedVideo, commandErrorMessage, FAVORITES_PLAYLIST_ID, getVideoParts, listPlaylists, saveLibraryTrack } from '../../services/desktopApi'
import type { Playlist } from '../../domain/library'
import { linkedFolderKey } from '../../services/linkedFolders'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { usePlayerStore } from '../player/playerStore'
import { playlistCapabilities,type PlaylistSelection } from './playlistSelection'
export function PlaylistPicker({ selection, onClose }: { selection: PlaylistSelection; onClose: () => void }) {
  const client = useQueryClient()
  const playlists = useQuery({ queryKey: accountQueryKey('playlists'), queryFn: listPlaylists })
  const epoch = useRef(accountEpoch()).current
  const lookups = [...new Set(selection.items.flatMap(item => item.kind === 'video' ? [item.bvid] : item.track.source.provider === 'bilibili' && !item.track.partCount ? [item.track.source.bvid] : []))]
  const details = useQuery({ queryKey: accountKeyAt(epoch, 'playlist-selection-parts', lookups), queryFn: () => Promise.all(lookups.map(bvid => getVideoParts(bvid))), enabled: Boolean(lookups.length), retry: false })
  const counts = Object.fromEntries((details.data || []).map(video => [video.bvid, video.parts.length]))
  const capabilities = playlistCapabilities(selection, counts)
  const resolving = Boolean(lookups.length && details.isPending)
  const eligible = (playlists.data || []).filter(playlist => playlist.biliFolderId ? capabilities.linked : capabilities.local)
  const [added, setAdded] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [completed, setCompleted] = useState<Record<string, Set<string>>>({})
  const add = async (playlist: Playlist) => {
    if (pending || epoch !== accountEpoch()) return
    setPending(true); setError('')
    try {
      if (playlist.biliFolderId) {
        const videos = [...new Set(selection.items.map(item => item.kind === 'video' ? item.bvid : item.track.source.bvid))]
        for (const bvid of videos) {
          if (epoch !== accountEpoch()) return
          if (completed[playlist.id]?.has(bvid)) continue
          const updated = await changeLinkedVideo(playlist.biliFolderId, bvid, true)
          if (epoch !== accountEpoch()) return
          client.setQueryData(linkedFolderKey(playlist.biliFolderId), updated)
          setCompleted(value => ({ ...value, [playlist.id]: new Set(value[playlist.id]).add(bvid) }))
        }
      } else {
        const tracks = selection.items.flatMap(item => {
          if (item.kind === 'track') return [item.track]
          const video = details.data?.find(video => video.bvid === item.bvid)
          return video?.parts.length === 1 ? [toTrack(video, video.parts[0])] : []
        })
        const saved: Track[] = []
        for (const track of tracks) {
          if (epoch !== accountEpoch()) return
          saved.push(await saveLibraryTrack(track))
        }
        if (epoch !== accountEpoch()) return
        await addTracksToPlaylist(playlist.id, saved.map(track => track.id))
        if (epoch !== accountEpoch()) return
        if (playlist.id === FAVORITES_PLAYLIST_ID) for (const track of saved) usePlayerStore.getState().updateTrack({ ...track, liked: true })
      }
      setAdded(playlist.id)
      await Promise.all(['playlists','library','home-recent'].map(key => client.invalidateQueries({ queryKey:[key] })))
    } catch (cause) { if (epoch === accountEpoch()) setError(commandErrorMessage(cause)) }
    finally { setPending(false) }
  }
  const label = selection.items.length === 1 ? (selection.items[0].kind === 'video' ? selection.items[0].title : selection.items[0].track.title) : `已选 ${selection.items.length} 项`
  return <CollectionDialog title="收藏到歌单" onClose={() => { if (!pending) onClose() }} className="unified-playlist-picker">
    <p>{label}</p>
    {resolving || playlists.isPending ? <p role="status"><LoaderCircle className="spin" size={16}/>正在读取歌单…</p> : <div className="playlist-destinations">{eligible.map(playlist => <button key={playlist.id} disabled={pending || added === playlist.id} onClick={() => void add(playlist)}><span className="playlist-destination-art">{playlist.biliFolderId ? <Link2 size={20}/> : <Library size={20}/>}</span><span><strong>{playlist.name}</strong><small>{playlist.trackCount} {playlist.biliFolderId ? '个视频 · B 站同步' : '首歌曲'}</small></span>{added === playlist.id ? <Check size={18}/> : <ListPlus size={18}/>}</button>)}</div>}
    {!resolving && !playlists.isPending && !eligible.length && <p className="collection-empty">{capabilities.linked ? '还没有关联歌单，请先导入 B 站收藏夹。' : capabilities.local ? '还没有歌单，请先创建一个。' : '当前选择同时包含整部多 P 视频和单独分 P，请分开收藏。'}</p>}
    {selection.items.some(item => item.kind === 'video' && counts[item.bvid] > 1) && <small className="playlist-capability-note">整部多 P 视频可收藏到与 B 站同步的歌单；单独分 P 可收藏到本地歌单。</small>}
    {(error || playlists.error || details.error) && <p role="alert" className="inline-error">{error || commandErrorMessage(playlists.error || details.error)}{details.isError && <button type="button" onClick={() => void details.refetch()}>重新读取视频信息</button>}</p>}
    {added && <p role="status" className="playlist-added"><Check size={16}/>已收藏到{playlists.data?.find(item => item.id === added)?.name}</p>}
  </CollectionDialog>
}

