import type { Track } from '../../domain/track'
import { replaceSeasonEntry } from './seasonQueue'

export type PlaybackCheckpoint = { bvid: string; cid: number; positionMs: number }
export type PreparedList = { queue: Track[]; trackId: string; startAt?: number }
/** Missing checkpoints must never apply their time to a different song. */
export async function prepareListPlayback(
  entries: readonly Track[], checkpoint: PlaybackCheckpoint | undefined,
  resolveParts: (entry: Track) => Promise<Track[]>, current: () => boolean,
): Promise<PreparedList | null> {
  let queue = [...entries]
  if (!checkpoint) return current() && queue[0] ? { queue, trackId: queue[0].id } : null
  const id = `bilibili:${checkpoint.bvid}:${checkpoint.cid}`
  if (!queue.some(t => t.id === id && !t.resolveParts)) {
    const entry = queue.find(t => t.resolveParts && t.source.bvid === checkpoint.bvid)
    if (!entry) return null
    const parts = await resolveParts(entry)
    if (!current()) return null
    queue = replaceSeasonEntry(queue, entry.id, parts)
  }
  return current() && queue.some(t => t.id === id && !t.resolveParts)
    ? { queue, trackId: id, startAt: checkpoint.positionMs / 1000 } : null
}
