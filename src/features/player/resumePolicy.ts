import type { Track } from '../../domain/track'

// null disables automatic checkpoint resume; explicit starts remain independent.
// Zero resumes videos of any duration.
export type ResumeThreshold = number | null
export type AutomaticResumePolicy = { enabled: boolean; thresholdSeconds: number; collection: boolean; durationSeconds: number }
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

export function shouldResumeVideo(threshold: ResumeThreshold, duration: number, _collection = false) {
  return threshold !== null && (threshold === 0 || Number.isFinite(duration) && duration >= threshold)
}

export function automaticResumePolicy(threshold: ResumeThreshold, durationSeconds: number, collection: boolean): AutomaticResumePolicy {
  return { enabled: threshold !== null, thresholdSeconds: threshold ?? 0, collection, durationSeconds }
}

// Called only once the player's metadata is ready. Its actual media duration
// takes precedence over search results and restored UI metadata.
export function automaticResumePosition(position: number, mediaDuration: number, policy: AutomaticResumePolicy) {
  const duration = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : policy.durationSeconds
  if (position >= 1 && policy.enabled && policy.thresholdSeconds > 0 && !(Number.isFinite(duration) && duration > 0)) throw new Error('无法读取视频总时长，请重新播放')
  return shouldResumeVideo(policy.enabled ? policy.thresholdSeconds : null, duration, policy.collection) &&
    Number.isFinite(position) && position >= 1 && (!Number.isFinite(duration) || duration <= 0 || position < duration - 1) ? position : 0
}

export function isCollectionPlayback(track: Track, queue: Track[], source?: { kind: string; collectionRef?: string }) {
  // Recommendation rows are independent songs even when several were found in
  // the same compilation video, so they must not turn into a collection queue.
  if (source?.kind === 'recommendation') return false
  return Boolean(source?.collectionRef) || source?.kind === 'season' || (track.partCount ?? 0) > 1 || track.source.page > 1 ||
    queue.some(item => item.id !== track.id && item.source.bvid === track.source.bvid)
}
