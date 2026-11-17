import {FolderPlus,MoreHorizontal} from 'lucide-react'
import type {Track} from '../../domain/track'
import {chooseTrackPlaylist,showTrackMenu,type TrackMenuActions} from './trackActionStore'
export function PlaylistButton({ track, tracks }: { track?: Track; tracks?: Track[] }) {
  return <button type="button" className="icon-action playlist-action" aria-label="加入歌单" title="加入歌单" onClick={(event) => { event.stopPropagation(); chooseTrackPlaylist(tracks || (track ? [track] : [])) }}><FolderPlus size={16} /></button>
}
export function TrackMenuButton({ track, playlistId, tracks, actions }: { track: Track; playlistId?: string; tracks?: Track[]; actions?: TrackMenuActions }) {
  return <button type="button" className="icon-action" aria-label="歌曲操作" title="更多操作" onClick={(event) => showTrackMenu(event, track, playlistId, tracks, actions)}><MoreHorizontal size={17} /></button>
}
