import type { SeasonSummary } from './bilibili'
import type { Track } from './track'
import { firstSongQuery } from './songIdentity'
import { importedPresentation, sourceTrack } from './importedPresentation'

export type SourceTitleContext = { videoTitle: string; partTitle: string; partCount: number; chapterContext?: boolean; season?: SeasonSummary }
export function withoutLegacyCatalog(context: SourceTitleContext) {
  const season = context.season
  // Older queues used synthetic seasons for linked folders and creator uploads.
  if (season && (
    (season.uploaderId === 0 && !season.uploaderName && !season.coverUrl)
    || (season.id === season.uploaderId && season.title === season.uploaderName)
  )) {
    return { ...context, season: undefined, chapterContext: false }
  }
  return context
}
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
  context = withoutLegacyCatalog(context)
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
  track = sourceTrack(track)
  if (track.sourceTitleContext) {
    const context = withoutLegacyCatalog(track.sourceTitleContext)
    if (context !== track.sourceTitleContext) track = { ...track, sourceTitleContext: context, chapterContext: false }
  }
  if (track.titleOverridden) return track.displayTitle === track.title ? track : { ...track, displayTitle: track.title }
  const title = track.sourceTitleContext ? contentTitle(track.sourceTitleContext) : track.displayTitle || track.title
  return importedPresentation(title === track.title && title === track.displayTitle ? track : { ...track, title, displayTitle: title })
}

type SeriesHeading = { kind?: string; title?: string; collectionRef?: string }
type SubtitleTrack = Pick<Track, 'artist' | 'sourceTitleContext' | 'titleOverridden' | 'importedEntry'> & { id?: string; source: Pick<Track['source'], 'uploaderName'> }
export function hasSeriesHeading(track: Pick<Track, 'sourceTitleContext'>, heading?: SeriesHeading) {
  const season = track.sourceTitleContext?.season
  return Boolean(season && (heading?.collectionRef === `season:${season.uploaderId}:${season.id}`
    || heading?.kind === 'season' && identity(heading.title || '') === identity(season.title)))
}
export function trackSubtitle(track: SubtitleTrack, heading?: SeriesHeading) {
  const artist = knownArtist(track)
  if (artist || hasSeriesHeading(track, heading)) return artist
  return track.sourceTitleContext?.season?.title || track.source.uploaderName || ''
}
export function knownArtist(track: SubtitleTrack) {
  const artist = track.artist?.trim() || ''
  const explicitArtist = track.titleOverridden || Boolean(track.importedEntry && track.importedEntry.trackId === track.id)
  return /^(?:歌手未知|未知歌手|未知|unknown(?: artist)?)$/i.test(artist) || !explicitArtist && identity(artist) === identity(track.source.uploaderName || '') ? '' : artist
}
