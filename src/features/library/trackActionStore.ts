import { create } from 'zustand'
import type { MouseEvent } from 'react'
import type { Track } from '../../domain/track'

type Menu = { track: Track; x: number; y: number; playlistId?: string; tracks?: Track[] }
export const useTrackActions = create<{ menu: Menu | null; adding: Track[] | null }>(() => ({ menu: null, adding: null }))
export function showTrackMenu(event: MouseEvent, track: Track, playlistId?: string, tracks?: Track[]) {
  event.preventDefault(); event.stopPropagation()
  useTrackActions.setState({ menu: { track, x: event.clientX, y: event.clientY, playlistId, tracks } })
}
export function chooseTrackPlaylist(tracks: Track[]) {
  if (tracks.length) useTrackActions.setState({ menu: null, adding: tracks })
}
