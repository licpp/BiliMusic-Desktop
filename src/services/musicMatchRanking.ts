import type { CatalogCandidate, LyricCandidate } from './desktopApi'

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
function similarity(a: string, b: string) {
  a = normalize(a); b = normalize(b)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const pairs = (value: string) => new Set(Array.from({length: value.length - 1}, (_, i) => value.slice(i, i + 2)))
  const left = pairs(a), right = pairs(b)
  return 2 * [...left].filter(pair => right.has(pair)).length / (left.size + right.size)
}
const domestic = (provider: string) => /netease|网易云|qq/i.test(provider) ? 1.5 : 0
function relevance(title: string, artist: string, requestedTitle: string, requestedArtist: string) {
  return similarity(title, requestedTitle) * 70 + (requestedArtist.trim() ? similarity(artist, requestedArtist) * 28 : 28)
}
// Source preference is deliberately tiny: a substantially weaker title/artist match cannot win.
export function rankLyricCandidates(items: LyricCandidate[], title: string, artist = '', duration = 0) {
  const score = (item: LyricCandidate) => relevance(item.trackName, item.artistName, title, artist)
    + domestic(item.provider) + (item.syncedLyrics ? 1 : 0)
    - (duration > 0 && item.duration > 0 ? Math.min(12, Math.abs(duration - item.duration) / 3) : 0)
  return [...items].sort((a, b) => score(b) - score(a))
}
export function rankCatalogCandidates(items: CatalogCandidate[], title: string, artist = '') {
  const score = (item: CatalogCandidate) => relevance(item.trackName, item.artistName, title, artist)
    + domestic(item.source) + (item.artworkUrl ? .5 : 0)
  return [...items].sort((a, b) => score(b) - score(a))
}
