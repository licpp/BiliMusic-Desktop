import type { Track } from '../../domain/track'
export type PlaylistItem = { kind: 'track'; track: Track } | { kind: 'video'; bvid: string; title: string }
export type PlaylistSelection = { items: PlaylistItem[] }
export function playlistCapabilities(selection: PlaylistSelection, partCounts: Record<string, number>) {
  const local = selection.items.length > 0 && selection.items.every(item => item.kind === 'track' || partCounts[item.bvid] === 1)
  const linked = selection.items.length > 0 && selection.items.every(item => item.kind === 'video' || item.track.source.provider === 'bilibili' && (item.track.partCount ?? partCounts[item.track.source.bvid]) === 1)
  return { local, linked }
}
