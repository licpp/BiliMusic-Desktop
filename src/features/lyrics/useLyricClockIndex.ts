import { useLayoutEffect, useState } from 'react'
import type { LyricLine } from '../../domain/lyrics'
import { lyricAt } from '../../domain/lyricTimeline'

/** Sample the playback clock every visible frame and render only on line changes. */
export function useLyricClockIndex(lines: LyricLine[], timeMs: number, clock?: () => number) {
  const [sample, setSample] = useState<{ lines: LyricLine[]; clock: () => number; index: number }>()
  useLayoutEffect(() => {
    if (!clock || !lines.length) return
    let frame = 0
    let lastIndex: number | undefined
    const update = () => {
      if (document.hidden) return
      const index = lyricAt(lines, clock())
      if (index !== lastIndex) {
        lastIndex = index
        setSample({ lines, clock, index })
      }
      frame = requestAnimationFrame(update)
    }
    const syncVisibility = () => {
      cancelAnimationFrame(frame)
      update()
    }
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', syncVisibility)
    }
  }, [lines, clock])
  return sample && sample.lines === lines && sample.clock === clock ? sample.index : lyricAt(lines, timeMs)
}
