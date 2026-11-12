import { rankDurationFirstSongCandidates, type ExternalSong, type SongCandidate } from './externalSongMatch'
import type { Track } from '../domain/track'

export type ImportSong = ExternalSong & { sourceId: string; album?: string; coverUrl?: string }
export type ImportPlaylist = { name: string; source: 'netease' | 'qq' | 'text'; songs: ImportSong[]; reportedCount: number; unavailableCount: number }
export type ImportChoice = { track: Track; evidence: SongCandidate }

export function parseSongList(text: string): ImportPlaylist {
  if (text.length > 1_000_000) throw new Error('内容过长，请分批导入')
  const songs: ImportSong[] = [], seen = new Set<string>()
  for (let line of text.split(/\r?\n/)) {
    line = line.trim()
    if (!line || /https?:\/\/|www\./i.test(line) || /^共\s*\d+\s*首/.test(line)) continue
    line = line.replace(/^\d{1,4}\s*[.、．:：]\s*/, '').replace(/^0\d\s+/, '')
    const duration = line.match(/\s+(\d{1,2}):(\d{2})$/)
    if (duration) line = line.slice(0, duration.index).trim()
    const [title, ...rest] = line.split(/\s+[-–—]\s*/)
    const artists = rest.join(' - ').split(/\s*[/、;；]\s*/).filter(Boolean)
    const clean = title.trim().replace(/^[「『《“"]+|[」』》”"]+$/g, '')
    if (!clean) continue
    const key = `${clean.normalize('NFKC').toLowerCase()}|${artists.join('/')}`
    if (seen.has(key)) continue
    seen.add(key)
    songs.push({ sourceId:`text:${key}`, title:clean, artists, durationSeconds:duration ? Number(duration[1]) * 60 + Number(duration[2]) : undefined })
  }
  if (!songs.length) throw new Error('没有识别到歌曲，请按每行「歌名 - 歌手」粘贴')
  if (songs.length > 5000) throw new Error('一次最多导入 5000 首，请分批导入')
  return { name:'导入的歌单',source:'text',songs,reportedCount:songs.length,unavailableCount:0 }
}

export function importKeyword(song: ImportSong, simple = false) {
  const primary = song.title.replace(/[（(](?:feat\.?|ft\.?|featuring)\s[^）)]*[）)]/giu,'')
    .replace(/[（(]([A-Za-z\s]+)[）)]/g,(whole,label: string) => /live|remix|cover|instrumental/i.test(label) ? whole : '')
    .trim()
  return simple ? primary : `${primary} ${song.artists[0] || ''}`.trim()
}
function normalized(value: string) { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'') }

/** Choose a useful default without making near-identical uploads require review.
 * Version conflicts and clear wrong-song/wrong-duration results are still skipped.
 */
export function chooseImportMatch(song: ImportSong, choices: ImportChoice[]): ImportChoice | undefined {
  const scored = rankDurationFirstSongCandidates(song,choices.map(choice=>choice.evidence)).ranked
  for (const item of scored) {
    const c = item.candidate
    if (!c.detailsVerified || !c.cid || item.versionConflict || item.titleEvidence === 'fuzzy') continue
    const context = normalized(`${c.title} ${c.videoTitle || ''} ${c.partTitle || ''} ${c.description || ''}`)
    const artistHit = song.artists.some(artist => context.includes(normalized(artist)))
    const titleSize = normalized(importKeyword(song,true)).length
    const distinctive = titleSize > 4 || (titleSize >= 3 && item.durationDifference !== undefined && item.durationDifference <= 1.5)
    const albumHit = song.album && normalized(song.album).length > 5 && context.includes(normalized(song.album))
    if (!artistHit && !distinctive && !albumHit) continue
    const live = /\blive\b|现场|演唱会/iu.test(song.title)
    const year = live ? song.album?.match(/(?:19|20)\d{2}/)?.[0] : undefined
    const actualYears: string[] = live ? `${c.title} ${c.videoTitle || ''} ${c.partTitle || ''}`.match(/(?:19|20)\d{2}/g) || [] : []
    if (year && actualYears.length && !actualYears.includes(year)) continue
    const duration = song.durationSeconds || 0
    if (duration && (item.durationDifference === undefined || item.durationDifference > Math.max(live ? 20 : 6, duration * (live ? 0.08 : 0.025)))) continue
    if (!duration && (!artistHit || item.capturePenalty > 0)) continue
    const choice = choices.find(choice=>choice.track.source.bvid === c.bvid && choice.track.source.cid === c.cid)
    if (choice) return choice
  }
}
