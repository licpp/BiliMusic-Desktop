export type PlaybackChapter = { startMs: number; title: string; endMs?: number }

export function chapterIndexAt(chapters: readonly PlaybackChapter[], timeMs: number) {
  let low = 0
  let high = chapters.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (chapters[middle].startMs <= timeMs) low = middle + 1
    else high = middle
  }
  const chapter = chapters[low - 1]
  return chapter && (chapter.endMs === undefined || timeMs < chapter.endMs) ? low - 1 : -1
}

export function chaptersWithinDuration(chapters: readonly PlaybackChapter[], durationSeconds: number) {
  return durationSeconds > 0 ? chapters.filter(chapter => chapter.startMs < durationSeconds * 1000) : chapters
}
