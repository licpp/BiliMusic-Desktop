import type { LyricLine } from './lyrics'

// A long missing tail is different from a normal instrumental outro. Do not
// extend the final caption or manufacture words the provider did not return.
export function subtitleCoverageEnd(lines: readonly LyricLine[] | undefined, durationSeconds: number) {
  const end = lines?.at(-1)?.endTimeMs
  return end !== undefined && Number.isFinite(end) && Number.isFinite(durationSeconds)
    && end > 0 && durationSeconds * 1000 - end > 60_000 ? end / 1000 : undefined
}
