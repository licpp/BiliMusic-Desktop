import { primarySongTitle, recognizeSong, songEditions, songTextIdentity as normalized } from '../domain/songIdentity'
import { rankImportSongCandidates, type SongCandidate } from './externalSongMatch'
import type { Track } from '../domain/track'

import type { ImportSong } from '../domain/importedEntry'
export type { ImportSong } from '../domain/importedEntry'
export type ImportPlaylist = { name: string; source: 'netease' | 'qq' | 'kugou' | 'kuwo' | 'migu' | 'text'; songs: ImportSong[]; reportedCount: number; unavailableCount: number }
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
  const primary = (recognizeSong(song).queries[0]?.title || primarySongTitle(song.title))
    .replace(/[（(][^）)]*\b(?:inst|orch)\b\.?[^）)]*[）)]/giu,'')
    .replace(/[（(]([A-Za-z.\s]+)[）)]/g,(whole,label: string) => songEditions(label).size ? whole : '')
    .trim()
  return simple ? primary : `${primary} ${song.artists[0] || ''}`.trim()
}

/** Choose a useful default without making near-identical uploads require review.
 * Version conflicts and clear wrong-song/wrong-duration results are still skipped.
 */
export function chooseImportMatch(song: ImportSong, choices: ImportChoice[]): ImportChoice | undefined {
  const scored = rankImportSongCandidates(song,choices.map(choice=>choice.evidence)).ranked
  for (const item of scored) {
    const c = item.candidate
    if (!item.automaticEligible || !c.detailsVerified || !c.cid || item.versionConflict || item.titleEvidence === 'fuzzy') continue
    const context = normalized(`${c.title} ${c.videoTitle || ''} ${c.partTitle || ''} ${c.description || ''}`)
    const artistHit = song.artists.some(artist => context.includes(normalized(artist)))
    const titleSize = normalized(importKeyword(song,true)).length
    const distinctive = titleSize > 4 || (titleSize >= 3 && item.durationDifference !== undefined && item.durationDifference <= 1.5)
    const albumHit = song.album && normalized(song.album).length > 5 && context.includes(normalized(song.album))
    if (!artistHit && !distinctive && !albumHit) continue
    const live = songEditions(song.title).has('live')
    const year = live ? song.album?.match(/(?:19|20)\d{2}/)?.[0] : undefined
    const actualYears: string[] = live ? `${c.title} ${c.videoTitle || ''} ${c.partTitle || ''}`.match(/(?:19|20)\d{2}/g) || [] : []
    if (year && actualYears.length && !actualYears.includes(year)) continue
    const duration = song.durationSeconds || 0
    if (duration && item.durationDifference !== undefined && item.durationDifference > Math.max(live ? 90 : 45, duration * (live ? .4 : .3))) continue
    if (!duration && (!artistHit || item.capturePenalty > 0)) continue
    const choice = choices.find(choice=>choice.track.source.bvid === c.bvid && choice.track.source.cid === c.cid && choice.evidence.bvid===c.bvid && choice.evidence.cid===c.cid)
    if (choice) return choice
  }
}

export function playlistLinkPlatform(input:string):string|undefined {
  const link=input.match(/https?:\/\/[^\s]+/)?.[0];if(!link)return
  try{const host=new URL(link).hostname;const groups:[string[],string][]=[
    [['music.163.com','163cn.tv'],'网易云音乐'],[['y.qq.com'],'QQ 音乐'],
    [['kugou.com','m.kugou.com','www.kugou.com','m3ws.kugou.com','t.kugou.com'],'酷狗音乐'],
    [['kuwo.cn','www.kuwo.cn','m.kuwo.cn','h5app.kuwo.cn'],'酷我音乐'],
    [['music.migu.cn','m.music.migu.cn','h5.nf.migu.cn','c.migu.cn'],'咪咕音乐'],
  ];return groups.find(([hosts])=>hosts.includes(host))?.[1]}catch{return}
}
