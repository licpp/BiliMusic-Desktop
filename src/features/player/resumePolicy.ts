import type { Track } from '../../domain/track'

// null disables single-video resume; zero resumes videos of any duration.
export type ResumeThreshold = number | null
export const MAX_RESUME_MINUTES = 60
export const RESUME_SLIDER_MAX = MAX_RESUME_MINUTES + 1

export function normalizeResumeThreshold(value: unknown): ResumeThreshold {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return value === 0 ? 0 : Math.min(MAX_RESUME_MINUTES, Math.max(1, Math.round(value / 60))) * 60
}

export function resumeSliderValue(threshold: ResumeThreshold) {
  return threshold === null ? 0 : threshold === 0 ? RESUME_SLIDER_MAX : RESUME_SLIDER_MAX - normalizeResumeThreshold(threshold)! / 60
}

export function resumeThresholdAt(value: number): ResumeThreshold {
  const step = Math.min(RESUME_SLIDER_MAX, Math.max(0, Math.round(value)))
  return step === 0 ? null : (RESUME_SLIDER_MAX - step) * 60
}

export function resumeThresholdLabel(threshold: ResumeThreshold) {
  if (threshold === null) return '关闭'
  if (threshold === 0) return '全部续播'
  return `≥ ${threshold / 60} 分钟`
}

export function shouldResumeVideo(threshold: ResumeThreshold, duration: number, collection = false) {
  return collection || threshold !== null && (threshold === 0 || Number.isFinite(duration) && duration >= threshold)
}

export function isCollectionPlayback(track: Track, queue: Track[], source?: { kind: string; collectionRef?: string }) {
  return Boolean(source?.collectionRef) || source?.kind === 'season' || (track.partCount ?? 0) > 1 || track.source.page > 1 ||
    queue.some(item => item.id !== track.id && item.source.bvid === track.source.bvid)
}
