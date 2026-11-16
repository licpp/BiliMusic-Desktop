import type { Track } from '../domain/track'
import type { BiliVideoParts } from '../domain/bilibili'
import type { MetadataPatch } from '../domain/library'
import { toTrack } from './collectionTrack'

export function originalBilibiliMetadata(track: Track, detail: BiliVideoParts): MetadataPatch {
  if (detail.bvid !== track.source.bvid) throw new Error('视频信息不一致，请重新读取')
  const part = detail.parts.find(part => part.cid === track.source.cid)
  if (!part) throw new Error('这个分 P 已移除，无法恢复原始信息')
  const original = toTrack(detail, part)
  return { title:original.title, artist:'', album:'', coverUrl:original.coverUrl || '' }
}
