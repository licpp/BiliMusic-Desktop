import type { TrackSource } from '../../domain/track'
import type { LyricLine } from '../../domain/lyrics'
import { alignLyricTiming, type LyricAlignment } from '../../domain/lyricAlignment'
import { lyricSubtitleLanguages } from '../../domain/subtitleLanguage'
import { getSubtitles, getSubtitleLines } from '../../services/mediaSources'

export async function automaticLyricBias(source: TrackSource, lines: readonly LyricLine[], valid: () => boolean) {
  if (source.provider !== 'bilibili' || !source.bvid || !(source.cid > 0)) throw new Error('这首歌暂时无法获取 AI 字幕')
  if (!valid()) return null
  const choices = await getSubtitles(source.bvid, source.cid)
  if (!valid()) return null
  const originalLanguages = lyricSubtitleLanguages(lines)
  const translated = lines.flatMap(line => line.translation && line.translation !== line.text
    ? [{ timeMs: line.timeMs, text: line.translation }] : [])
  const translatedLanguages = lyricSubtitleLanguages(translated)
  const candidates = choices.filter(choice => choice.language && (
    choice.ai || originalLanguages.has(choice.languageKey) || translatedLanguages.has(choice.languageKey)
  )).map(choice => ({
    ...choice,
    rank: (originalLanguages.has(choice.languageKey) ? 0 : translatedLanguages.has(choice.languageKey) ? 2 : 4)
      + Number(!choice.ai),
  })).sort((a, b) => a.rank - b.rank)
  if (!candidates.length) throw new Error('这段视频暂无可用于对齐的字幕')

  let failure: Extract<LyricAlignment, { ok: false }>['reason'] | undefined
  let translatedMatch: Extract<LyricAlignment, { ok: true }> | undefined
  let fetchError: unknown
  for (const [index, choice] of candidates.entries()) {
    if (!valid()) return null
    let captions: LyricLine[]
    try {
      captions = await getSubtitleLines(source.bvid, source.cid, choice.language)
    } catch (error) {
      if (!valid()) return null
      fetchError ??= error
      continue
    }
    if (!valid()) return null
    const result = alignLyricTiming(lines, captions)
    if (result.ok) return result
    if (!failure || failure === 'insufficient') failure = result.reason
    if (!translatedMatch && translatedLanguages.has(choice.languageKey)) {
      const alternate = alignLyricTiming(translated, captions)
      if (alternate.ok) translatedMatch = alternate
    }
    // All original-language candidates have now been tried. A translation
    // supplied with the lyrics can provide the same timestamps as the original.
    if (translatedMatch && failure === 'insufficient' && (candidates[index + 1]?.rank ?? 4) >= 4) return translatedMatch
  }
  if (translatedMatch && failure === 'insufficient') return translatedMatch
  if (!failure && fetchError) throw fetchError
  throw new Error(failure === 'range' ? '时间差超过 30 秒，请更换歌词版本'
    : failure === 'inconsistent' ? '各段歌词时间差不同，请手动调整或更换版本'
    : '未找到与歌词一致的字幕，请手动微调')
}
