import type { SourceTitleContext } from './sourceTitle'
import type { ImportedEntry } from './importedEntry'
import type { RecommendationBindingRef } from './recommendation'
export type TrackSource = {
  provider: 'bilibili'
  bvid: string
  aid?: number
  cid: number
  page: number
  uploaderId?: number
  uploaderName?: string
}

export type Track = {
  id: string
  source: TrackSource
  title: string
  artist?: string
  album?: string
  coverUrl?: string
  durationSeconds: number
  liked: boolean
  sourceExpired?: boolean
  resolveParts?: boolean
  chapterContext?: boolean
  sourceTitleContext?: SourceTitleContext
  titleOverridden?: boolean
  displayTitle?: string
  videoTitle?: string
  publishedAt?: number
  playCount?: number
  partCount?: number
  /** Playlist-local catalog presentation; never a manual metadata override. */
  importedEntry?: ImportedEntry
  importedSourceMetadata?: Pick<Track, 'title' | 'displayTitle' | 'artist' | 'album' | 'coverUrl'>
  recommendationBinding?: RecommendationBindingRef
}

export const sourceIdentity = (source: TrackSource) =>
  `${source.provider}:${source.bvid}:${source.cid}`
