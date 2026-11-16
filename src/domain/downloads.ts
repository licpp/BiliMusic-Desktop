import type { Track } from './track'

export type DownloadRecord = { id: string; trackId: string; targetPath: string; status: 'queued' | 'downloading' | 'completed' | 'failed'; receivedBytes: number; totalBytes?: number; errorMessage?: string; track?: Track }
