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
  if (synced.length) return synced
  return (candidate.plainLyrics || '').split(/\r?\n/).filter(Boolean).map((text, index) => ({ timeMs: index * 4_000, text }))
}

export function bestCandidate(candidates: LyricCandidate[], durationSeconds: number): LyricCandidate | undefined {
  return [...candidates]
    .filter((candidate) => candidate.syncedLyrics || candidate.plainLyrics)
    .sort((left, right) => score(right, durationSeconds) - score(left, durationSeconds))[0]
}

function score(candidate: LyricCandidate, durationSeconds: number) {
  const durationDelta = durationSeconds > 0 && candidate.duration > 0 ? Math.abs(candidate.duration - durationSeconds) : 0
  return (candidate.syncedLyrics ? 100 : 0) + (candidate.plainLyrics ? 10 : 0) - Math.min(durationDelta, 60)
}
