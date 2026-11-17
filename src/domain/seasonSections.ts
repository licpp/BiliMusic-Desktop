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
