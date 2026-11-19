export function fitMediaFrame(width: number, height: number, ratio: number) {
  const aspect = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9
  const h = Math.max(0, Math.min(height, width / aspect))
  return { width: h * aspect, height: h }
}

export function playerDensity(width: number, height: number) {
  if (height < 350) return 'tight'
  if (height < 540 || (height < 680 && width / height >= 2.05)) return 'compact'
  return 'regular'
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
