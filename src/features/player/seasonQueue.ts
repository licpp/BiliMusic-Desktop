import type { Track } from '../../domain/track'

export function replaceSeasonEntry(queue: Track[], entryId: string, parts: Track[], allowEmpty = false) {
  if ((!parts.length && !allowEmpty) || !queue.some(track => track.id === entryId && track.resolveParts)) return queue
  return [...new Map(queue.flatMap(track => track.id === entryId ? parts : [track]).map(track => [track.id, track])).values()]
}
