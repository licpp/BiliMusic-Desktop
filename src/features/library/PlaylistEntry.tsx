import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Album, FolderOpen, Heart, Link2, ListPlus, Pencil, Play, RefreshCw, Trash2, Unlink2 } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage, deletePlaylist, listPlaylistTracks, renamePlaylist, unlinkBiliFolder, type Playlist } from '../../services/desktopApi'
import { linkedFolderKey, reloadLinkedFolder } from '../../services/linkedFolders'
import { ActionMenu } from '../../shared/ActionMenu'
import { Artwork } from '../../shared/Artwork'
import { CollectionDialog } from '../../shared/CollectionDialog'
import type { MenuPosition } from '../../shared/useRowContextMenu'
import { usePlayerStore } from '../player/playerStore'
import { LibraryEntry } from './LibraryEntry'

export function PlaylistMenu({ playlist, onOpen, onRemoved, onRefresh, onRematch, contextPosition }: {
  playlist: Playlist
  onOpen?: () => void
  onRemoved?: () => void
  onRefresh?: () => Promise<unknown>
  onRematch?: () => void
  contextPosition?: MenuPosition
}) {
  const client = useQueryClient()
  const [action, setAction] = useState<'rename' | 'delete' | 'unlink'>()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const folderId = playlist.biliFolderId
  const label = '歌单'
  const title = action === 'rename' ? '重命名歌单' : action === 'unlink' ? '解除关联' : '删除歌单'
  const prepare = (next: typeof action) => {
    setName(playlist.name)
    setError('')
    setAction(next)
  }
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await work() }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  const play = (enqueue: boolean) => run(async () => {
    const epoch = accountEpoch()
    const tracks = await listPlaylistTracks(playlist.id)
    if (epoch !== accountEpoch()) return
    const player = usePlayerStore.getState()
    if (enqueue) player.enqueue(tracks)
    else await player.playAll(tracks)
  })
  return <>
    <ActionMenu sheet label={`${label}操作：${playlist.name}`} contextPosition={contextPosition}>{close => <>
      {onOpen && <button role="menuitem" onClick={() => { close(); onOpen() }}><FolderOpen size={16}/>打开{label}</button>}
      {folderId ? <>
        <button role="menuitem" disabled={busy} onClick={() => { close(); void run(() => onRefresh ? onRefresh() : reloadLinkedFolder(client, folderId)) }}><RefreshCw size={16}/>刷新收藏夹</button>
        <button role="menuitem" disabled={busy} onClick={() => { close(); prepare('unlink') }}><Unlink2 size={16}/>解除关联</button>
      </> : <>
        <button role="menuitem" disabled={busy || !playlist.trackCount} onClick={() => { close(); void play(false) }}><Play size={16}/>播放全部</button>
        <button role="menuitem" disabled={busy || !playlist.trackCount} onClick={() => { close(); void play(true) }}><ListPlus size={16}/>全部加入队列</button>
        {onRematch&&<button role="menuitem" disabled={busy||!playlist.trackCount} onClick={()=>{close();onRematch()}}><RefreshCw size={16}/>重新匹配视频</button>}
        {!playlist.isSystem && <>
          <button role="menuitem" disabled={busy} onClick={() => { close(); prepare('rename') }}><Pencil size={16}/>重命名歌单</button>
          <button role="menuitem" disabled={busy} onClick={() => { close(); prepare('delete') }}><Trash2 size={16}/>删除歌单</button>
        </>}
      </>}
    </>}</ActionMenu>
    {error && !action && <button type="button" className="library-toast" role="alert" onClick={() => setError('')}>{error}</button>}
    {action && <CollectionDialog title={title} onClose={() => { if (!busy) setAction(undefined) }}>
      <form onSubmit={event => {
        event.preventDefault()
        if (busy || (action === 'rename' && !name.trim())) return
        void run(async () => {
          const epoch = accountEpoch()
          if (action === 'rename') await renamePlaylist(playlist.id, name.trim())
          else if (action === 'unlink' && folderId) await unlinkBiliFolder(folderId)
          else await deletePlaylist(playlist.id)
          if (epoch !== accountEpoch()) return
          if (folderId) client.setQueryData(linkedFolderKey(folderId), null)
          setAction(undefined)
          if (action !== 'rename') onRemoved?.()
          await Promise.all(['playlists','library','home-recent'].map(key => client.invalidateQueries({queryKey:[key]})))
        })
      }}>
        {action === 'rename' ? <input aria-label="歌单名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} /> :
          <p>{action === 'unlink' ? `解除「${playlist.name}」的关联？B 站原收藏夹会保留。` : `删除「${playlist.name}」？歌曲、播放记录和其他歌单会保留。`}</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        <footer>
          <button type="button" className="collection-flat-button" disabled={busy} onClick={() => setAction(undefined)}>取消</button>
          <button type="submit" className={action === 'rename' ? 'collection-primary' : 'collection-flat-button action-danger'} disabled={busy || (action === 'rename' && !name.trim())}>{busy ? '处理中…' : title}</button>
        </footer>
      </form>
    </CollectionDialog>}
  </>
}

export function PlaylistEntry({ playlist, sidebar = false, active = false, onOpen, onRemoved }: {
  playlist: Playlist
  sidebar?: boolean
  active?: boolean
  onOpen: () => void
  onRemoved?: () => void
}) {
  const cover = <Artwork src={playlist.coverUrl} adaptAspect className={playlist.isSystem?'favorites-playlist-artwork':undefined}
    fallback={playlist.isSystem?<Heart size={17} fill="currentColor"/>:playlist.biliFolderId?<Link2 aria-hidden="true"/>:<Album size={17}/>}
    imageOverlay={playlist.isSystem?<span className="favorites-heart-overlay" aria-hidden="true"><Heart fill="none" strokeWidth={2.2}/></span>:undefined}/>
  const subtitle = `${playlist.trackCount}${playlist.biliFolderId ? ' 个视频 · B 站同步' : playlist.isSystem ? ' 首 · 默认歌单' : ' 首'}`
  return <LibraryEntry title={playlist.name} titleAdornment={playlist.biliFolderId ? <Link2 size={13} className="playlist-link-mark" aria-label="与 B 站同步"/> : undefined} subtitle={subtitle} cover={cover} sidebar={sidebar} active={active} onOpen={onOpen}
    coverClassName={playlist.isSystem ? 'favorites-cover' : undefined}
    menu={position => <PlaylistMenu playlist={playlist} contextPosition={position} onOpen={onOpen} onRemoved={onRemoved}/>}/>
}
