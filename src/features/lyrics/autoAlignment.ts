import type { TrackSource } from '../../domain/track'
import type { LyricLine } from '../../domain/lyrics'
import { alignLyricTiming } from '../../domain/lyricAlignment'
import { getSubtitles, getSubtitleLines } from '../../services/mediaSources'

export async function automaticLyricBias(source: TrackSource, lines: readonly LyricLine[], valid: () => boolean) {
  if (source.provider !== 'bilibili' || !source.bvid || !(source.cid > 0)) throw new Error('这首歌暂时无法获取 AI 字幕')
  if (!valid()) return null
  const choices = await getSubtitles(source.bvid, source.cid)
  if (!valid()) return null
  const chinese = /\p{Script=Han}/u.test(lines.map(line => line.text).join(''))
  const ai = choices.filter(choice => choice.ai)
  const choice = ai.find(choice => chinese ? /zh|cmn/i.test(choice.language) : /en/i.test(choice.language)) || ai[0]
  if (!choice) throw new Error('这段视频暂无 AI 字幕')
  const captions = await getSubtitleLines(source.bvid, source.cid, choice.language)
  if (!valid()) return null
  const result = alignLyricTiming(lines, captions)
  if (!result.ok) {
    const message = result.reason === 'range' ? '时间差超过 30 秒，请更换歌词版本'
      : result.reason === 'inconsistent' ? '各段歌词时间差不同，请手动调整或更换版本'
      : '未找到足够一致的歌词，请手动微调'
    throw new Error(message)
  }
  return result
}
