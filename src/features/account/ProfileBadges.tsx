import { Crown, Shield } from 'lucide-react'
import type { AccountProfile } from '../../services/desktopApi'

export function ProfileBadges({ level, vipActive }: Pick<AccountProfile, 'level' | 'vipActive'>) {
  if (level == null && !vipActive) return null
  return <span className="account-badges">
    {level != null && <span className="account-badge account-level" data-tier={level >= 6 ? 'gold' : level >= 4 ? 'violet' : 'teal'} aria-label={`B 站等级 ${level}`}>
      <span className="account-level-mark"><Shield size={15} fill="currentColor" aria-hidden="true"/></span><span>Lv.<b>{level}</b></span>
    </span>}
    {vipActive && <span className="account-badge account-vip"><Crown size={14} aria-hidden="true"/>大会员</span>}
  </span>
}
