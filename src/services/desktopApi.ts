import { invoke, isTauri } from '@tauri-apps/api/core'

export type BiliSearchItem = { bvid: string; title: string; uploaderName: string; uploaderId: number; coverUrl: string; durationSeconds: number; playCount: number; description: string }
export type BiliSearchPage = { items: BiliSearchItem[]; page: number; pageSize: number; total: number }
export type BiliVideoPart = { cid: number; page: number; title: string; durationSeconds: number; coverUrl: string }
export type BiliVideoParts = { bvid: string; aid: number; title: string; coverUrl: string; uploaderName: string; uploaderId: number; parts: BiliVideoPart[] }
export type PlaybackSource = { audioUrl: string; backupUrls: string[]; mimeType: string; codecs: string; bandwidth: number }
export type DesktopCommandError = { code: string; message: string; retryable: boolean }

export const inDesktopShell = isTauri()

export async function searchBilibili(keyword: string, page = 1): Promise<BiliSearchPage> {
  if (!inDesktopShell) return { items: [], page, pageSize: 20, total: 0 }
  return invoke<BiliSearchPage>('bili_search', { keyword, page, pageSize: 20 })
}

export const getVideoParts = (bvid: string) => invoke<BiliVideoParts>('bili_video_parts', { bvid })
export const getPlaybackSource = (bvid: string, cid: number) => invoke<PlaybackSource>('bili_playback_source', { bvid, cid })

export function commandErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as DesktopCommandError).message)
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}
