import type { Track } from '../../domain/track'

export type QueueReorderScope = 'track' | 'group' | 'part'

export function groupQueue(queue: Track[]) {
  const groups: { key: string; bvid?: string; tracks: Track[] }[] = []
  for (const track of queue) {
    const bvid = track.source.provider === 'bilibili' ? track.source.bvid : undefined
    const previous = groups.at(-1)
    // A video can occur in separate runs in a manually ordered playlist.
    // Keep those runs separate so the visual order matches playback.
    if (bvid && previous?.bvid === bvid) {
      previous.tracks.push(track)
      // Keep the expansion attached to its group when songs are reordered.
      if (track.id < previous.key) previous.key = track.id
    } else {
      groups.push({ key: track.id, bvid, tracks: [track] })
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

export function reorderQueueTracks(
  queue: Track[], sourceIds: string[], targetIds: string[], position: 'before' | 'after',
  scope: QueueReorderScope, kind?: 'video' | 'season',
) {
  const { structured, groups } = presentQueue(queue, kind)
  if (scope === 'track' ? structured : !structured) return queue

  if (scope === 'group') {
    const matches = (ids: string[]) => groups.some(({ tracks }) =>
      tracks.length === ids.length && tracks.every((track, index) => track.id === ids[index]))
    if (!matches(sourceIds) || !matches(targetIds)) return queue
  } else {
    if (sourceIds.length !== 1 || targetIds.length !== 1) return queue
    if (scope === 'part' && !groups.some(({ tracks }) =>
      tracks.some(track => track.id === sourceIds[0]) && tracks.some(track => track.id === targetIds[0]))) return queue
  }

  const from = queue.findIndex(track => track.id === sourceIds[0])
  const target = queue.findIndex(track => track.id === targetIds[0])
  if (from < 0 || target < 0 || from === target) return queue
  const boundary = target + (position === 'after' ? targetIds.length : 0)
  const to = boundary - (from < target ? sourceIds.length : 0)
  if (from === to) return queue

  const next = [...queue]
  const moved = next.splice(from, sourceIds.length)
  next.splice(to, 0, ...moved)
  return next
}
