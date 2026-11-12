import type { LyricCandidate, LyricLine } from '../../services/desktopApi'

const timestamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?]/g

export function parseLrc(source: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const rawLine of source.split(/\r?\n/)) {
    const text = rawLine.replace(timestamp, '').trim()
    const matches = [...rawLine.matchAll(timestamp)]
    for (const match of matches) {
      const fraction = (match[3] || '').padEnd(3, '0').slice(0, 3)
      lines.push({ timeMs: Number(match[1]) * 60_000 + Number(match[2]) * 1_000 + Number(fraction), text })
    }
  }
  return lines.filter((line) => line.text).sort((left, right) => left.timeMs - right.timeMs)
}

export function candidateLines(candidate: LyricCandidate): LyricLine[] {
  const synced = candidate.syncedLyrics ? parseLrc(candidate.syncedLyrics) : []
  if (synced.length) return attachSupplementalLyrics(synced, candidate.translatedLyrics, candidate.romanizedLyrics)
  return (candidate.plainLyrics || '').split(/\r?\n/).filter(Boolean).map((text, index) => ({ timeMs: index * 4_000, text }))
}

export function attachSupplementalLyrics(lines: LyricLine[], translated?: string, romanized?: string): LyricLine[] {
  const result = lines.map(line => ({ ...line }))
  for (const [field, source] of [['translation', translated], ['romanization', romanized]] as const) {
    if (!source) continue
    for (const auxiliary of parseLrc(source)) {
      // The services can round timestamps differently. Match time, never line number:
      // translation files often omit credits, instrumental passages or repeated lines.
      let low = 0, high = result.length
      while (low < high) { const mid = (low + high) >>> 1; if (result[mid].timeMs < auxiliary.timeMs) low = mid + 1; else high = mid }
      const indices = [low - 1, low].filter(index => index >= 0 && index < result.length)
      const index = indices.sort((a, b) => Math.abs(result[a].timeMs - auxiliary.timeMs) - Math.abs(result[b].timeMs - auxiliary.timeMs))[0]
      if (index === undefined || Math.abs(result[index].timeMs - auxiliary.timeMs) > 120) continue
      const text = auxiliary.text.trim()
      if (!text || text === '//' || text === result[index].text || text === result[index][field]) continue
      result[index][field] = result[index][field] ? `${result[index][field]} / ${text}` : text
    }
  }
  return result
}

export type LyricSupplement = 'off' | 'romanization' | 'translation'
export function lyricSupplementModes(lines: LyricLine[]): LyricSupplement[] {
  return ['off', ...(lines.some(line => line.romanization) ? ['romanization'] : []), ...(lines.some(line => line.translation) ? ['translation'] : [])] as LyricSupplement[]
}
export function nextLyricSupplement(mode: LyricSupplement, modes: LyricSupplement[]): LyricSupplement {
  return modes[(Math.max(0, modes.indexOf(mode)) + 1) % modes.length] || 'off'
}

export function bestCandidate(candidates: LyricCandidate[], durationSeconds: number): LyricCandidate | undefined {
  return [...candidates]
    .filter((candidate) => candidate.syncedLyrics || candidate.plainLyrics)
    .sort((left, right) => score(right, durationSeconds) - score(left, durationSeconds))[0]
}

function score(candidate: LyricCandidate, durationSeconds: number) {
  const durationDelta = durationSeconds > 0 && candidate.duration > 0 ? Math.abs(candidate.duration - durationSeconds) : 0
  return (candidate.syncedLyrics ? 100 : 0) + (candidate.plainLyrics ? 10 : 0) + (candidate.translatedLyrics ? 3 : 0) + (candidate.romanizedLyrics ? 3 : 0) + (/netease|qq/.test(candidate.provider) ? 1.5 : 0) - Math.min(durationDelta, 60)
}
