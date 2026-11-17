import { create } from 'zustand'
import type { MouseEvent } from 'react'
import type { Track } from '../../domain/track'
import type { PlaylistSelection } from './playlistSelection'

export type TrackMenuActions = { visibilityScope?: string; openParts?: () => void; play?: () => void; replaceVideo?: () => void }
type Menu = TrackMenuActions & { track: Track; x: number; y: number; playlistId?: string; tracks?: Track[]; openParts?: () => void; play?: () => void }
export const useTrackActions = create<{ menu: Menu | null; adding: PlaylistSelection | null }>(() => ({ menu: null, adding: null }))
export function showTrackMenu(event: MouseEvent, track: Track, playlistId?: string, tracks?: Track[], actions?: TrackMenuActions) {
  event.preventDefault(); event.stopPropagation()
  useTrackActions.setState({ menu: { track, x: event.clientX, y: event.clientY, playlistId, tracks, ...actions } })
}
export function chooseTrackPlaylist(tracks: Track[]) {
  if (tracks.length) useTrackActions.setState({ menu: null, adding: { items: tracks.map(track => track.resolveParts ? { kind: 'video', bvid: track.source.bvid, title: track.title } : { kind: 'track', track }) } })
}
export function chooseVideoPlaylist(video: { bvid: string; title: string }) {
  useTrackActions.setState({ menu: null, adding: { items: [{ kind: 'video', bvid: video.bvid, title: video.title }] } })
}
