export function fitMediaFrame(width: number, height: number, ratio: number) {
  const aspect = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9
  const h = Math.max(0, Math.min(height, width / aspect))
  return { width: h * aspect, height: h }
}

export function playerViewportLayout(width: number, height: number) {
  const density = height < 350 ? 'tight'
    : height < 540 || (height < 680 && width / height >= 2.05) ? 'compact' : 'regular'
  // The horizontal control row needs room for progress and touch targets.
  return { density, wideMedia: density !== 'regular' && width >= 720 } as const
}

export function lyricRowCount(availableHeight: number, supplemental: boolean) {
  if (availableHeight < (supplemental ? 210 : 156)) return 1
  if (availableHeight < (supplemental ? 360 : 300)) return 3
  return !supplemental && availableHeight >= 560 ? 7 : 5
}

export function observePlayerBox(element: HTMLElement, resize: () => void) {
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
  if (observer) observer.observe(element)
  else {
    window.addEventListener('resize', resize)
    window.addEventListener('bilimusic-keyboard', resize)
  }
  resize()
  return () => {
    if (observer) observer.disconnect()
    else {
      window.removeEventListener('resize', resize)
      window.removeEventListener('bilimusic-keyboard', resize)
    }
  }
}

// Native scroll padding allows the first and final lyric to reach the center.
export function centeredLyricScroll(lineOffset: number, lineHeight: number, viewportHeight: number, scrollHeight: number) {
  return Math.max(0, Math.min(Math.max(0, scrollHeight - viewportHeight), lineOffset + lineHeight / 2 - viewportHeight / 2))
}
