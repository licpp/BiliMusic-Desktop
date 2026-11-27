import { lyricDisplayText } from '../../domain/lyricDisplay'
import { memo, useEffect, useRef, type CSSProperties } from 'react'
import type { LyricLine } from '../../domain/lyrics'
import { wordMotion } from './appleLyricMotion'

function wordProgressRatio(start: number, end: number, time: number) {
  return Math.max(0, Math.min(1, (time - start) / Math.max(1, end - start)))
}

export function wordProgress(start: number, end: number, time: number) {
  return `${wordProgressRatio(start, end, time) * 100}%`
}

function applyWordStyle(style: CSSStyleDeclaration, start: number, end: number, time: number) {
  const ratio = wordProgressRatio(start, end, time)
  const progress = `${ratio * 100}%`
  if (style.getPropertyValue('--word-progress') !== progress) style.setProperty('--word-progress', progress)
  const motion = wordMotion(ratio, end - start)
  const lift = motion.liftPx === 0 ? '0px' : `${motion.liftPx}px`
  if (style.getPropertyValue('--word-lift') !== lift) style.setProperty('--word-lift', lift)
  const glow = String(motion.glow)
  if (style.getPropertyValue('--word-glow') !== glow) style.setProperty('--word-glow', glow)
}

export const WordLyric = memo(function WordLyric({ line, timeMs, active, clock, stableLayout }: {
  line: LyricLine
  timeMs: number
  active: boolean
  clock?: () => number
  stableLayout?: boolean
}) {
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!active || !line.words?.length || !clock) return
    let frame = 0
    const paint = () => {
      if (document.hidden) return
      const now = clock()
      line.words!.forEach((word, index) => {
        const style = (root.current?.children[index] as HTMLElement | undefined)?.style
        if (style) applyWordStyle(style, word.startTimeMs, word.endTimeMs, now)
      })
      frame = requestAnimationFrame(paint)
    }
    const syncVisibility = () => {
      cancelAnimationFrame(frame)
      paint()
    }
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', syncVisibility)
    }
  }, [active, line, clock])
  if ((!active && !stableLayout) || !line.words?.length) return <>{lyricDisplayText(line.text)}</>
  return <span ref={root} className="word-lyric" data-inactive={!active || undefined} aria-label={active ? lyricDisplayText(line.text) : undefined}>{line.words.map((word, index) => {
    if (!active) return <span key={index} className="lyric-word">{lyricDisplayText(word.text)}</span>
    const ratio = wordProgressRatio(word.startTimeMs, word.endTimeMs, timeMs)
    const motion = wordMotion(ratio, word.endTimeMs - word.startTimeMs)
    return <span key={index} className="lyric-word" aria-hidden="true" style={{ '--word-progress': `${ratio * 100}%`, '--word-lift': motion.liftPx === 0 ? '0px' : `${motion.liftPx}px`, '--word-glow': String(motion.glow) } as CSSProperties}>{lyricDisplayText(word.text)}</span>
  })}</span>
})
