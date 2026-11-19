import type { BiliVideoAccess } from '../domain/bilibili'
import { LockKeyhole, Zap } from 'lucide-react'

const labels: Record<BiliVideoAccess, string> = {
  paid: '付费视频',
  chargeExclusive: '充电专属',
  chargeEarlyAccess: '抢先看',
}

export function VideoAccessBadge({ access, onCover }: { access?: BiliVideoAccess; onCover?: boolean }) {
  if (!access) return null
  const Icon = access === 'paid' ? LockKeyhole : Zap
  return <span className="video-access-badge" data-cover={onCover || undefined}>
    <Icon aria-hidden="true" fill={access === 'paid' ? 'none' : 'currentColor'}/>{labels[access]}
  </span>
}
