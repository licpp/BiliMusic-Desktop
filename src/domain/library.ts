import type { SourceTitleContext } from './sourceTitle'
export type StoredTrack = { id: string; bvid: string; aid?: number; cid: number; page: number; sourceDisplayTitle?:string; sourceVideoTitle?:string; titleOverridden?:boolean; sourceTitleContext?:SourceTitleContext; title: string; artist?: string; album?: string; coverUrl?: string; durationSeconds: number; uploaderId?: number; uploaderName?: string; liked: boolean }
export type MetadataPatch = { title: string; artist?: string; album?: string; coverUrl?: string }
export type Playlist = { id: string; name: string; description: string; coverUrl?: string; trackCount: number; isSystem: boolean; biliFolderId?: number; addedAt?: number }
export type CatalogSource = 'auto' | 'netease' | 'qq' | 'itunes' | 'musicbrainz'
export type CatalogCandidate = { trackId: string; trackName: string; artistName: string; collectionName?: string; artworkUrl?: string; source: string }
