import type { Track } from '../../domain/track'

export function replaceSeasonEntry(queue: Track[], entryId: string, parts: Track[]) {
  if (!parts.length || !queue.some(track => track.id === entryId && track.resolveParts)) return queue
  return [...new Map(queue.flatMap(track => track.id === entryId ? parts : [track]).map(track => [track.id, track])).values()]
}
