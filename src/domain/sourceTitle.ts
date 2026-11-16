import type { SeasonSummary } from './bilibili'
import type { Track } from './track'
import { firstSongQuery } from './songIdentity'

export type SourceTitleContext = { videoTitle: string; partTitle: string; partCount: number; chapterContext?: boolean; season?: SeasonSummary }
const genericPart = (value: string) => /^(?:p\s*\d+|part\s*\d+|正片|视频|默认|默认标题)$/i.test(value.normalize('NFKC'))
const identity = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const trimSeparator = (value: string) => value.replace(/^[\s:：|丨/·,，—–\-\]】)）]+/, '').trim()

/** Only remove a verified series prefix, at a word / chapter boundary. */
export function withoutSeriesPrefix(title: string, series = '') {
  const prefix = identity(series), normalized = title.normalize('NFKC')
  if (!prefix || prefix.length < 3) return title.trim()
  let matched = '', end = 0
  for (const letter of normalized) {
    end += letter.length
    matched += identity(letter)
    if (!prefix.startsWith(matched)) return title.trim()
    if (matched === prefix) break
  }
  const rest = normalized.slice(end)
  const suffix = trimSeparator(rest)
  const boundary = /^[^\p{L}\p{N}]/u.test(rest) || /^(?:\d|第[一二三四五六七八九十百零〇\d]|序言|前言|后记|番外)/u.test(rest)
  return matched === prefix && boundary && suffix && !genericPart(suffix) ? suffix : title.trim()
}

/** A season contains independent single-P videos as well as multi-P chapters. */
export function sourceTitle(videoTitle: string, partTitle: string, partCount: number, chapter: boolean, seriesTitle = '') {
  const part = partTitle.trim()
  const useful = part && !genericPart(part)
  const base = useful && (partCount > 1 || chapter) ? part : videoTitle.trim()
  return chapter || partCount > 1 ? withoutSeriesPrefix(base, seriesTitle) : base
}

export function contentTitle(context: SourceTitleContext) {
  const title = sourceTitle(context.videoTitle, context.partTitle, context.partCount, Boolean(context.season || context.chapterContext), context.season?.title)
  // Music presentation wrappers have explicit evidence. Arbitrary book / film
  // quotes must not become a song name or silently select one song in a medley.
  if (!context.season && context.partCount === 1 && /录音棚|录音室|戴上耳机听|【(?:私藏馆|音乐分享|音乐推荐)】/.test(title)) {
    const quotes = title.match(/《[^《》]+》|「[^「」]+」|“[^“”]+”/g)
    if (quotes?.length === 1) return firstSongQuery({ title }).title
  }
  return title
}

export function withTrackTitle(track: Track): Track {
  if (track.titleOverridden) return track.displayTitle === track.title ? track : { ...track, displayTitle: track.title }
  const title = track.sourceTitleContext ? contentTitle(track.sourceTitleContext) : track.displayTitle || track.title
  return title === track.title && title === track.displayTitle ? track : { ...track, title, displayTitle: title }
}

type SeriesHeading = { kind?: string; title?: string; collectionRef?: string }
export function hasSeriesHeading(track: Track, heading?: SeriesHeading) {
  const season = track.sourceTitleContext?.season
  return Boolean(season && (heading?.collectionRef === `season:${season.uploaderId}:${season.id}`
    || heading?.kind === 'season' && identity(heading.title || '') === identity(season.title)))
}
export function trackSubtitle(track: Track, heading?: SeriesHeading) {
  if (hasSeriesHeading(track, heading)) return knownArtist(track)
  return track.sourceTitleContext?.season?.title || knownArtist(track) || track.source.uploaderName || ''
}
export function knownArtist(track: Track) {
  const artist = track.artist?.trim() || ''
  return /^(?:歌手未知|未知歌手|未知|unknown(?: artist)?)$/i.test(artist) || identity(artist) === identity(track.source.uploaderName || '') ? '' : artist
}
