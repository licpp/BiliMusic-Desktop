import { visibleCheckpoint } from '../../domain/contentVisibility'
import type { Track } from '../../domain/track'
import { replaceSeasonEntry } from './seasonQueue'

export type PlaybackCheckpoint = { bvid: string; cid: number; positionMs: number }
export type PreparedList = { queue: Track[]; trackId: string; startAt?: number }
/** Missing checkpoints must never apply their time to a different song. */
export async function prepareListPlayback(
  entries: readonly Track[], checkpoint: PlaybackCheckpoint | undefined,
  resolveParts: (entry: Track) => Promise<Track[]>, current: () => boolean,
  allowed: (entry:Track)=>boolean = ()=>true,
): Promise<PreparedList | null> {
  let queue = [...entries]
  if (!checkpoint) {const first=queue.find(allowed);return current() && first?{queue,trackId:first.id}:null}
  const id = `bilibili:${checkpoint.bvid}:${checkpoint.cid}`
  if (!queue.some(t => t.id === id && !t.resolveParts)) {
    const entry = queue.find(t => t.resolveParts && t.source.bvid === checkpoint.bvid)
    if (!entry) return null
    if(!allowed(entry)){const next=visibleCheckpoint(queue,entry.id,allowed).track;return current()&&next?{queue,trackId:next.id,startAt:0}:null}
    const parts = await resolveParts(entry)
    if (!current()) return null
    queue = replaceSeasonEntry(queue, entry.id, parts)
  }
  if(!current() || !queue.some(t=>t.id===id&&!t.resolveParts))return null
  const selected=visibleCheckpoint(queue,id,allowed)
  return selected.track?{queue,trackId:selected.track.id,...(selected.same?{startAt:checkpoint.positionMs/1000}:{startAt:0})}:null
}
