import type { Playlist } from '../../domain/library'
import { FAVORITES_PLAYLIST_ID } from '../../services/desktopApi'

export function canEditPlaylistTracks(playlist?: Playlist) {
  return Boolean(playlist && !playlist.biliFolderId && (!playlist.isSystem || playlist.id === FAVORITES_PLAYLIST_ID))
}
