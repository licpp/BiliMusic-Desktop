import { visibleCheckpoint } from '../../domain/contentVisibility'
import type { Track } from '../../domain/track'
import { replaceSeasonEntry } from './seasonQueue'

export type PlaybackCheckpoint = { bvid: string; cid: number; positionMs: number }
export type PreparedList = { queue: Track[]; trackId: string; sourceTrackId?: string; startAt?: number }
/** Missing checkpoints must never apply their time to a different song. */
export async function prepareListPlayback(
  entries: readonly Track[], checkpoint: PlaybackCheckpoint | undefined,
  resolveParts: (entry: Track) => Promise<Track[]>, current: () => boolean,
  allowed: (entry:Track)=>boolean = ()=>true,
  localParts?: (entry: Track) => Track[],
): Promise<PreparedList | null> {
  let queue = [...entries]
  const available = (entry: Track) => allowed(entry) ? (localParts?.(entry) ?? [entry]).filter(allowed) : []
  if (!checkpoint) {
    const first = queue.find(entry => available(entry).length > 0)
    return current() && first ? { queue, trackId: first.id } : null
  }
  const id = `bilibili:${checkpoint.bvid}:${checkpoint.cid}`
  if (localParts) {
    const entry = queue.find(track => track.id === id) ??
      queue.find(track => track.resolveParts && track.source.bvid === checkpoint.bvid)
    if (!current() || !entry) return null
    const source = visibleCheckpoint(queue, entry.id, track => available(track).length > 0).track
    if (!source) return null
    const parts = available(source)
    const target = parts.find(part => part.id === id) ?? parts[0]
    return { queue, trackId: target.id, sourceTrackId: source.id, startAt: target.id === id ? checkpoint.positionMs / 1000 : 0 }
  }
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
