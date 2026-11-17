import type { SeasonSection } from './bilibili'

export function selectedSeasonSection(sections: SeasonSection[] | undefined, id: string | undefined) {
  return sections && sections.length > 1 ? sections.find(section => section.id === id) : undefined
}

// Filter before applying the user's sorting rule. One BV may expand into several
// playable parts; keep every part and retain the original order within that BV.
export function filterSeasonSection<T extends { source:{ bvid:string } }>(tracks:T[], sections:SeasonSection[] | undefined, id:string | undefined):T[] {
  const section = selectedSeasonSection(sections,id)
  if (!section) return tracks
  const groups = new Map<string,T[]>()
  for (const track of tracks) {
    const group = groups.get(track.source.bvid) || []
    group.push(track); groups.set(track.source.bvid,group)
  }
  return [...new Set(section.bvids)].flatMap(bvid => groups.get(bvid) || [])
}

// Resolve from the actual prepared target (which may skip a hidden checkpoint).
// Preserve the chosen sort and every resolved part when narrowing the queue.
export function seasonResumeSelection<T extends { id:string;source:{bvid:string} }>(tracks:T[], trackId:string, sections:SeasonSection[] | undefined, selected?:string) {
  const bvid = tracks.find(track => track.id === trackId)?.source.bvid
  const current = selectedSeasonSection(sections,selected)
  const section = bvid && sections && sections.length > 1
    ? current?.bvids.includes(bvid) ? current : sections.find(section => section.bvids.includes(bvid))
    : undefined
  const members = section && new Set(section.bvids)
  return {sectionId:section?.id,tracks:members ? tracks.filter(track => members.has(track.source.bvid)) : tracks}
}
