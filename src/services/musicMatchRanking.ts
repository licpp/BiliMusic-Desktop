import type { CatalogCandidate } from '../domain/library'
import type { LyricCandidate } from '../domain/lyrics'
import { songQueries, songTitleIdentity, songTokenSimilarity, type SongQuery } from '../domain/songIdentity'
const domestic = (provider: string) => /netease|网易云|qq/i.test(provider) ? 1.5 : 0
function relevance(title: string, artist: string, queries: SongQuery[]) {
  return Math.max(0, ...queries.map(query => {
    const titleScore = songTitleIdentity(title) === songTitleIdentity(query.title) ? 1 : songTokenSimilarity(title, query.title)
    return titleScore * 70 + (query.artist.trim() ? songTokenSimilarity(artist, query.artist) * 28 : 28)
  }))
}
// Source preference is deliberately tiny: a substantially weaker title/artist match cannot win.
export function rankLyricCandidates(items: LyricCandidate[], title: string, artist = '', duration = 0, queries = songQueries({ title, artist })) {
  const score = (item: LyricCandidate) => relevance(item.trackName, item.artistName, queries)
    + domestic(item.provider) + (item.syncedLyrics ? 1 : 0)
    - (duration > 0 && item.duration > 0 ? Math.min(12, Math.abs(duration - item.duration) / 3) : 0)
  return [...items].sort((a, b) => score(b) - score(a))
}
export function rankCatalogCandidates(items: CatalogCandidate[], title: string, artist = '', queries = songQueries({ title, artist })) {
  const score = (item: CatalogCandidate) => relevance(item.trackName, item.artistName, queries)
    + domestic(item.source) + (item.artworkUrl ? .5 : 0)
  return [...items].sort((a, b) => score(b) - score(a))
}
