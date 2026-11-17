import type { Track } from './track'
export type VisibilityRule = { scope: string; target: string; hidden: boolean }
export type VisibilityOrigin = string // empty string means an explicit saved/queued item
export const videoScope = (bvid: string) => `video:${bvid}`
/** Hiding organizes a saved container or a followed creator, never arbitrary results. */
export function canManageVisibility(scope: string | undefined, saved: readonly { bvid: string }[], tracks: readonly Track[] = [], parentScope?: string): boolean {
  if (!scope) return false
  const references = new Set(saved.map(item => item.bvid))
  const reference = scope.startsWith('video:') ? scope.slice(6) : scope
  if (references.has(reference)) return true
  if (parentScope && /^(?:season:|up:)/.test(parentScope) && references.has(parentScope)) return true
  for (const container of [reference, parentScope]) {
    const owner = /^(?:season|up):(\d+)(?::|$)/.exec(container ?? '')?.[1]
    if (owner && references.has(`up:${owner}`)) return true
  }
  if (!scope.startsWith('video:')) return false
  return tracks.some(track => {
    if (track.source.bvid !== reference) return false
    if (track.source.uploaderId && references.has(`up:${track.source.uploaderId}`)) return true
    const season = track.sourceTitleContext?.season
    return Boolean(season && references.has(`season:${season.uploaderId}:${season.id}`))
  })
}

export function listVisibilityOrigins(track: Track, source?: { collectionRef?: string; visibilityManaged?: boolean }): VisibilityOrigin[] {
  return [!source || source.visibilityManaged === false ? '' : source.collectionRef?.startsWith('season:') ? source.collectionRef : videoScope(track.source.bvid)]
}
export const ruleKey = (rule: Pick<VisibilityRule, 'scope' | 'target'>) => JSON.stringify([rule.scope, rule.target])
// Store snapshots are immutable. Reuse their index across thousands of queue rows.
const ruleIndices = new WeakMap<readonly VisibilityRule[], Map<string, boolean>>()
const partIndices = new WeakMap<readonly Track[], Map<string, Track[]>>()
export function visibilityIndex(rules: readonly VisibilityRule[]) {
  let index=ruleIndices.get(rules)
  if(!index){index=new Map(rules.map(rule=>[ruleKey(rule),rule.hidden]));ruleIndices.set(rules,index)}
  return index
}
function expandedByVideo(tracks: readonly Track[]) {
  let index=partIndices.get(tracks)
  if(!index){index=new Map();for(const track of tracks)if(!track.resolveParts){const parts=index.get(track.source.bvid)??[];parts.push(track);index.set(track.source.bvid,parts)}partIndices.set(tracks,index)}
  return index
}
export function trackHidden(track: Track, origin: VisibilityOrigin, rules: readonly VisibilityRule[]): boolean {
  if (!origin) return false
  const index = visibilityIndex(rules), bvid = track.source.bvid
  if (origin.startsWith('season:') && index.get(ruleKey({ scope: origin, target: bvid }))) return true
  return !track.resolveParts && Boolean(index.get(ruleKey({ scope: videoScope(bvid), target: `cid:${track.source.cid}` })))
}
export function entryAllowed(track: Track, origins: readonly VisibilityOrigin[], rules: readonly VisibilityRule[]) {
  return !origins.length || origins.some(origin => !trackHidden(track, origin, rules))
}
export function projectVisibility(tracks: readonly Track[], scope: string, rules: readonly VisibilityRule[]) {
  const visible = tracks.filter(track => !trackHidden(track, scope, rules))
  return { original: tracks.length, visible, hidden: tracks.length - visible.length }
}
export function visibilityChange(track: Track, scope: string, hidden: boolean): VisibilityRule {
  return scope.startsWith('season:') ? { scope, target: track.source.bvid, hidden } :
    { scope: videoScope(track.source.bvid), target: `cid:${track.source.cid}`, hidden }
}
/** Only known complete BV expansions may collapse. Original page/count/title context is intact. */
export function projectSeasonRows(rows: readonly Track[], expanded: readonly Track[], scope: string, rules: readonly VisibilityRule[]) {
  const groups=expandedByVideo(expanded),index=visibilityIndex(rules)
  return rows.flatMap(row => {
    if (index.get(ruleKey({scope,target:row.source.bvid}))) return []
    const parts = groups.get(row.source.bvid) ?? []
    if (!parts.length) return [row]
    const expected = row.partCount ?? parts[0].partCount ?? parts[0].sourceTitleContext?.partCount
    if (!expected || parts.length !== expected) return [row]
    const visible = parts.filter(t => !trackHidden(t, scope, rules))
    return !visible.length ? [] : visible.length === 1 ? [visible[0]] : [row]
  })
}
/** A hidden checkpoint chooses the next source entry, then wraps; never transfers its time. */
export function visibleCheckpoint(entries: readonly Track[], checkpointId: string, allowed: (track: Track) => boolean) {
  const index = entries.findIndex(track => track.id === checkpointId)
  const eligible = entries.filter(allowed)
  const same = eligible.find(track => track.id === checkpointId)
  return same ? { track: same, same: true } : {
    track: entries.slice(Math.max(0, index + 1)).find(allowed) ?? eligible[0], same: false,
  }
}

/** Keep the audible row's source position even when its visible queue row disappeared. */
export function orderedQueueTarget(order: readonly string[], visible: readonly string[], current: string, direction: number, wrap: boolean) {
  const visibleIndex=visible.indexOf(current)
  const sequence=visibleIndex>=0?visible:order
  const index=sequence.indexOf(current), available=new Set(visible)
  if(index<0)return direction>0?visible[0]:visible[visible.length-1]
  const candidates=direction>0?sequence.slice(index+1):sequence.slice(0,index).reverse()
  const next=candidates.find(id=>available.has(id))
  return next ?? (wrap?(direction>0?visible[0]:visible[visible.length-1]):undefined)
}

/** Persist the source order plus only suppressed rows, not a second copy of the queue. */
export function packQueueBase(queue: readonly Track[], base: readonly Track[]) {
  const visible=new Set(queue.map(track=>track.id))
  return {queueOrder:base.map(track=>track.id),hiddenQueueTracks:base.filter(track=>!visible.has(track.id))}
}
export function unpackQueueBase(queue: readonly Track[], order?: readonly string[], hidden: readonly Track[] = []) {
  const rows=new Map([...hidden,...queue].filter(track=>!track.id.startsWith('local:')).map(track=>[track.id,track]))
  return [...new Set([...(order??[]),...rows.keys()])].flatMap(id=>rows.has(id)?[rows.get(id)!]:[])
}
