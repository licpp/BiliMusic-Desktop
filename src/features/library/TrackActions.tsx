import { useOverlayDismiss } from '../../shared/useOverlayDismiss'
import { offlineUnavailable, useOfflinePlayback } from '../player/offlinePlayback'
import { HideAction } from '../../shared/VisibilityControls'
import { useVisibilityRules } from '../../services/contentVisibility'
import { accountQueryKey } from '../../services/queryKeys'
import { useQueryClient } from '@tanstack/react-query'
import { Download,FolderPlus,ListMusic,ListVideo,Pencil,Play,RefreshCw,Trash2 } from 'lucide-react'
import { useEffect,useLayoutEffect,useRef,useState } from 'react'
import { createPortal } from 'react-dom'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage,FAVORITES_PLAYLIST_ID,removeTrackFromPlaylist,saveLibraryTrack } from '../../services/desktopApi'
import { DownloadDialogHost } from '../downloads/DownloadDialog'
import { chooseDownload } from '../downloads/downloadRequest'
import { usePlayerStore } from '../player/playerStore'
import { MetadataDialog } from './MetadataDialog'
import { PlaylistPicker } from './PlaylistPicker'
import { chooseTrackPlaylist,useTrackActions } from './trackActionStore'

export { PlaylistButton,TrackMenuButton } from './TrackMenuButton'
export function TrackActionsHost() {
  const offline = useOfflinePlayback()
  const { menu, adding } = useTrackActions()
  const visibilityRules = useVisibilityRules()
  const [editing, setEditing] = useState<Track | null>(null)
  const [error, setError] = useState('')
  const element = useRef<HTMLDivElement>(null)
  const menuLayer = useRef<HTMLDivElement>(null)
  const editRequest = useRef(0)
  const client = useQueryClient()
  useEffect(() => {
    const clear = () => { ++editRequest.current; useTrackActions.setState({ menu: null, adding: null }); setEditing(null) }
    window.addEventListener('bilimusic-account-changing', clear)
    return () => { ++editRequest.current; window.removeEventListener('bilimusic-account-changing', clear) }
  }, [])
  const closeMenu = () => useTrackActions.setState({ menu: null })
  useOverlayDismiss(menuLayer, Boolean(menu), closeMenu, true)
  useLayoutEffect(() => {
    const panel = element.current
    if (!panel || !menu) return
    const previous = document.activeElement
    const viewport = window.visualViewport
    const place = () => {
      const left = viewport?.offsetLeft ?? 0
      const top = viewport?.offsetTop ?? 0
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      panel.style.left = `${Math.max(left + 8, Math.min(menu.x, left + width - panel.offsetWidth - 8))}px`
      panel.style.top = `${Math.max(top + 8, Math.min(menu.y, top + height - panel.offsetHeight - 8))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(panel)
    viewport?.addEventListener('resize', place)
    viewport?.addEventListener('scroll', place)
    window.addEventListener('resize', place)
    panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    return () => {
      observer.disconnect()
      viewport?.removeEventListener('resize', place)
      viewport?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
      if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
    }
  }, [menu])
  const refresh = () => { void client.invalidateQueries({ queryKey: accountQueryKey('library') }); void client.invalidateQueries({ queryKey: accountQueryKey('home-recent') }); void client.invalidateQueries({ queryKey: accountQueryKey('playlists') }) }
  const edit = async (track: Track) => {
    const epoch = accountEpoch(), request = ++editRequest.current
    const current = () => epoch === accountEpoch() && request === editRequest.current
    useTrackActions.setState({ menu: null })
    try { const saved = await saveLibraryTrack(track); if (current()) setEditing(saved) }
    catch (cause) { if (current()) setError(commandErrorMessage(cause)) }
  }
  const remove = async (playlistId: string, track: Track) => {
    try { await removeTrackFromPlaylist(playlistId, track.id); if (playlistId === FAVORITES_PLAYLIST_ID) usePlayerStore.getState().updateTrack({ ...track, liked: false }); refresh() }
    catch (cause) { setError(commandErrorMessage(cause)) }
  }
  return createPortal(<>
    {menu && <div className="track-menu-layer" ref={menuLayer}>
    <div className="track-menu-scrim" onClick={event => { event.stopPropagation(); closeMenu() }} />
    <div ref={element} className="track-context-menu" role="menu" aria-label="歌曲操作" onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => { if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return; event.preventDefault(); const buttons = [...element.current!.querySelectorAll('button')]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus() }}>
      <small>{menu.track.title}</small>
      <button role="menuitem" disabled={offlineUnavailable(menu.track, offline)} onClick={() => { if (menu.play) menu.play(); else void (menu.tracks ? usePlayerStore.getState().playFromList(menu.tracks, menu.track.id) : usePlayerStore.getState().play(menu.track)); useTrackActions.setState({ menu: null }) }}><Play size={15} />播放</button>
      {menu.openParts && <button role="menuitem" onClick={() => { useTrackActions.setState({ menu: null }); menu.openParts?.() }}><ListVideo size={15}/>查看选集</button>}
      {menu.replaceVideo && <button role="menuitem" onClick={() => { const replace=menu.replaceVideo; useTrackActions.setState({ menu: null }); replace?.() }}><RefreshCw size={15}/>更换视频</button>}
      <button role="menuitem" disabled={offlineUnavailable(menu.track, offline)} onClick={() => { usePlayerStore.getState().enqueue([menu.track]); useTrackActions.setState({ menu: null }) }}><ListMusic size={15} />加入播放队列</button>
      {menu.visibilityScope && <HideAction track={menu.track} scope={menu.visibilityScope} rules={visibilityRules} onDone={()=>useTrackActions.setState({menu:null})}/>}
      <button role="menuitem" onClick={() => chooseTrackPlaylist([menu.track])}><FolderPlus size={15} />收藏到歌单…</button>
      {menu.track.source.provider === 'bilibili' && <button role="menuitem" onClick={() => { const track=menu.track; useTrackActions.setState({menu:null}); chooseDownload([track]) }}><Download size={15} />下载歌曲</button>}
      <button role="menuitem" onClick={() => void edit(menu.track)}><Pencil size={15} />编辑歌曲信息</button>
      {menu.playlistId && <button role="menuitem" onClick={() => { void remove(menu.playlistId!, menu.track); useTrackActions.setState({ menu: null }) }}><Trash2 size={15} />{menu.playlistId === FAVORITES_PLAYLIST_ID ? '取消喜欢' : '从当前歌单移除'}</button>}
    </div></div>}
    <DownloadDialogHost/>
    {adding && <PlaylistPicker selection={adding} onClose={() => useTrackActions.setState({ adding: null })} />}
    {editing && <MetadataDialog track={editing} onClose={() => setEditing(null)} onSaved={(track) => { usePlayerStore.getState().updateTrack(track); setEditing(null); refresh() }} />}
    {error && <button className="library-toast" role="alert" onClick={() => setError('')}>{error}</button>}
  </>, document.body)
}
