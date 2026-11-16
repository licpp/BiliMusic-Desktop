export interface AutomaticResumePolicy {
  enabled: boolean;
  thresholdSeconds: number;
  collection: boolean;
  durationSeconds: number;
}

export function playbackStartPosition(position: number, duration: number, policy?: AutomaticResumePolicy): number {
  if (!Number.isFinite(position) || position < 0) return 0;
  if (!policy) return position;
  const total = Number.isFinite(duration) && duration > 0 ? duration : policy.durationSeconds;
  if (position >= 1 && policy.enabled && policy.thresholdSeconds > 0 && !(Number.isFinite(total) && total > 0)) throw new Error('无法读取视频总时长，请重新播放');
  const resume = policy.enabled && (policy.thresholdSeconds <= 0 || Number.isFinite(total) && total >= policy.thresholdSeconds);
  return resume && position >= 1 && (!Number.isFinite(total) || total <= 0 || position < total - 1) ? position : 0;
}
