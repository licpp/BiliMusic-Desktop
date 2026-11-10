export type TrackSource = {
  provider: 'bilibili' | 'local'
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
  resolveParts?: boolean
}

export const sourceIdentity = (source: TrackSource) =>
  `${source.provider}:${source.bvid}:${source.cid}`
