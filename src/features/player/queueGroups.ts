import type { Track } from '../../domain/track'

export function groupQueue(queue: Track[]) {
  const groups: { key: string; bvid?: string; tracks: Track[] }[] = []
  const runs = new Map<string, number>()
  for (const track of queue) {
    const bvid = track.source.provider === 'bilibili' ? track.source.bvid : undefined
    const previous = groups.at(-1)
    // A video can occur in separate runs in a manually ordered playlist.
    // Keep those runs separate so the visual order matches playback.
    if (bvid && previous?.bvid === bvid) {
      previous.tracks.push(track)
    } else {
      const run = bvid ? (runs.get(bvid) ?? 0) + 1 : 0
      if (bvid) runs.set(bvid, run)
      groups.push({ key: bvid ? `${bvid}:${run}` : track.id, bvid, tracks: [track] })
    }
  }
  return groups
}

export function presentQueue(queue: Track[], kind?: 'video' | 'season') {
  const structured = kind === 'season' || (!kind && queue.some(track => track.resolveParts))
    || (kind === 'video' && queue.some(track => track.source.bvid !== queue[0]?.source.bvid))
  return {
    structured,
    partsOnly: !structured && kind === 'video' && queue.length > 1,
    groups: structured ? groupQueue(queue) : queue.map(track => ({ key: track.id, tracks: [track] })),
  }
}

export function moveQueueTracks(queue: Track[], ids: string[], direction: -1 | 1, byVideo = false) {
  const group = (track: Track) => [track]
  const blocks = byVideo ? groupQueue(queue).map(item => item.tracks) : queue.map(group)
  const index = blocks.findIndex(block => block[0].id === ids[0])
  const adjacent = blocks[index + direction]
  if (index < 0 || !adjacent) return queue
  const own = blocks[index]
  if (own.length !== ids.length || own.some((track, i) => track.id !== ids[i])) return queue
  if (!byVideo && own[0].source.bvid !== adjacent[0].source.bvid) return queue
  ;[blocks[index], blocks[index + direction]] = [adjacent, own]
  return blocks.flat()
}
