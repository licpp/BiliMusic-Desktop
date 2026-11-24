import { invoke } from '@tauri-apps/api/core'
import type { PlaybackChapter } from '../domain/playbackChapters'

export type SavedChapter = Pick<PlaybackChapter, 'startMs' | 'title'>
export type SavedChapterSnapshot = { session: string; revision: string; chapters: SavedChapter[] | null }
type VideoPart = { bvid: string; cid: number }

export const savedChaptersQuery = 'saved-playback-chapters'
export const listOfficialChapters = (part: VideoPart) => invoke<PlaybackChapter[]>('bili_video_chapters', part)
export const readSavedChapters = (part: VideoPart) => invoke<SavedChapterSnapshot>('get_saved_chapters', part)
export const writeSavedChapters = (part: VideoPart, base: SavedChapterSnapshot, chapters: SavedChapter[] | null) =>
  invoke<SavedChapterSnapshot>('save_chapters', { ...part, session: base.session, revision: base.revision, chapters })
