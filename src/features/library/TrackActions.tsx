import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FolderPlus, ListMusic, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react'
import type { Track } from '../../domain/track'
import { commandErrorMessage, FAVORITES_PLAYLIST_ID, removeTrackFromPlaylist, saveLibraryTrack } from '../../services/desktopApi'
import { usePlayerStore } from '../player/playerStore'
import { MetadataDialog, PlaylistPicker } from './LibraryView'
import { chooseTrackPlaylist, showTrackMenu, useTrackActions } from './trackActionStore'

export function PlaylistButton({ track, tracks }: { track?: Track; tracks?: Track[] }) {
  return <button type="button" className="icon-action playlist-action" aria-label="加入歌单" title="加入歌单" onClick={(event) => { event.stopPropagation(); chooseTrackPlaylist(tracks || (track ? [track] : [])) }}><FolderPlus size={16} /></button>
}
export function TrackMenuButton({ track, playlistId }: { track: Track; playlistId?: string }) {
  return <button type="button" className="icon-action" aria-label="歌曲操作" title="更多操作" onClick={(event) => showTrackMenu(event, track, playlistId)}><MoreHorizontal size={17} /></button>
}
export function TrackActionsHost() {
  const { menu, adding } = useTrackActions()
  const [editing, setEditing] = useState<Track | null>(null)
  const [error, setError] = useState('')
  const element = useRef<HTMLDivElement>(null)
  const client = useQueryClient()
  useEffect(() => {
    const clear = () => { useTrackActions.setState({ menu: null, adding: null }); setEditing(null) }
    window.addEventListener('bilimusic-account-changing', clear)
    return () => window.removeEventListener('bilimusic-account-changing', clear)
  }, [])
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!element.current?.contains(event.target as Node)) useTrackActions.setState({ menu: null }) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && (menu || adding || editing)) { event.stopPropagation(); useTrackActions.setState({ menu: null, adding: null }); setEditing(null) } }
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [menu, adding, editing])
  useEffect(() => { if (menu) element.current?.querySelector('button')?.focus() }, [menu])
  const refresh = () => { void client.invalidateQueries({ queryKey: ['library'] }); void client.invalidateQueries({ queryKey: ['home-recent'] }); void client.invalidateQueries({ queryKey: ['playlists'] }) }
  const edit = async (track: Track) => { useTrackActions.setState({ menu: null }); try { setEditing(await saveLibraryTrack(track)) } catch (cause) { setError(commandErrorMessage(cause)) } }
  const remove = async (playlistId: string, track: Track) => {
    try { await removeTrackFromPlaylist(playlistId, track.id); if (playlistId === FAVORITES_PLAYLIST_ID) usePlayerStore.getState().updateTrack({ ...track, liked: false }); refresh() }
    catch (cause) { setError(commandErrorMessage(cause)) }
  }
  return createPortal(<>
    {menu && <div ref={element} className="track-context-menu" role="menu" aria-label="歌曲操作" style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 222)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 230)) }} onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => { if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return; event.preventDefault(); const buttons = [...element.current!.querySelectorAll('button')]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus() }}>
      <small>{menu.track.title}</small>
      <button role="menuitem" onClick={() => { void usePlayerStore.getState().play(menu.track); useTrackActions.setState({ menu: null }) }}><Play size={15} />播放</button>
      <button role="menuitem" onClick={() => { usePlayerStore.getState().enqueue([menu.track]); useTrackActions.setState({ menu: null }) }}><ListMusic size={15} />加入播放队列</button>
      <button role="menuitem" onClick={() => chooseTrackPlaylist([menu.track])}><FolderPlus size={15} />加入歌单…</button>
      <button role="menuitem" onClick={() => void edit(menu.track)}><Pencil size={15} />编辑歌曲信息</button>
      {menu.playlistId && <button role="menuitem" onClick={() => { void remove(menu.playlistId!, menu.track); useTrackActions.setState({ menu: null }) }}><Trash2 size={15} />{menu.playlistId === FAVORITES_PLAYLIST_ID ? '取消喜欢' : '从当前歌单移除'}</button>}
    </div>}
    {adding && <PlaylistPicker tracks={adding} onClose={() => useTrackActions.setState({ adding: null })} />}
    {editing && <MetadataDialog track={editing} onClose={() => setEditing(null)} onSaved={(track) => { usePlayerStore.getState().updateTrack(track); setEditing(null); refresh() }} />}
    {error && <button className="library-toast" role="alert" onClick={() => setError('')}>{error}</button>}
  </>, document.body)
}
