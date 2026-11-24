import { resolveVipBadge, type AccountProfile, type VipTier } from '../../domain/account'

type BadgeProps = Pick<AccountProfile, 'level' | 'seniorMember' | 'vipActive' | 'vipType' | 'vipTheme' | 'vipLabel'>

function SeniorBolt() {
  return <svg className="account-senior-bolt" width="10" height="11" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true">
    <path d="M5.9 0.5 1.1 6.7h3.3L3.6 11.5l5.3-6.6H5.5L5.9 0.5Z" />
  </svg>
}

function VipEmblem({ tier }: { tier: VipTier }) {
  if (tier === 'ten_annual') {
    // 10-year milestone diamond-star crest
    return <svg className="account-vip-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.4 10.1 5.2l4.3.7-3.1 3.1.7 4.3L8 11.2 4 13.3l.7-4.3L1.6 5.9l4.3-.7L8 1.4Z" fill="currentColor" fillOpacity=".24" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <circle cx="8" cy="7.9" r="1.75" fill="currentColor" />
    </svg>
  }
  if (tier === 'hundred_annual') {
    // Prismatic faceted diamond emblem
    return <svg className="account-vip-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.3 2.5h7.4L14.5 6.3 8 13.8 1.5 6.3 4.3 2.5Z" fill="currentColor" fillOpacity=".22" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M1.8 6.3h12.4M5.4 2.6 8 13.5 10.6 2.6" stroke="currentColor" strokeWidth="1.05" strokeOpacity=".85" strokeLinejoin="round" />
    </svg>
  }
  if (tier === 'annual') {
    // Bilibili-inspired mini-TV with twin V-antennas and star sparkle
    return <svg className="account-vip-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M5.4 2.1 7.3 4M10.6 2.1 8.7 4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <rect x="2" y="4.2" width="12" height="9.2" rx="2.7" fill="currentColor" fillOpacity=".2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 6.4 8.7 8.1l1.7.7-1.7.7L8 11.2 7.3 9.5 5.6 8.8l1.7-.7L8 6.4Z" fill="currentColor" />
    </svg>
  }
  // Standard monthly VIP: Bilibili-inspired mini-TV with crisp V mark
  return <svg className="account-vip-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M5.4 2.2 7.3 4.1M10.6 2.2 8.7 4.1" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    <rect x="2" y="4.3" width="12" height="9" rx="2.7" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth="1.25" />
    <path d="M5.8 7.1 8 10.6 10.2 7.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

export function ProfileBadges({ level, seniorMember, vipActive, vipType, vipTheme, vipLabel }: BadgeProps) {
  const vip = resolveVipBadge({ vipActive, vipType, vipTheme, vipLabel })
  if (level == null && !vip) return null
  const clampedLevel = level == null ? null : Math.max(0, Math.min(6, Math.trunc(level)))
  const isSenior = clampedLevel === 6 && Boolean(seniorMember)
  return <span className="account-badges">
    {clampedLevel != null && <span
      className="account-badge account-level"
      data-level={clampedLevel}
      data-senior={isSenior || undefined}
      aria-label={`B 站等级 ${clampedLevel}${isSenior ? ' 硬核会员' : ''}`}
    >
      <span className="account-lv-prefix" aria-hidden="true">LV</span>
      <b>{clampedLevel}</b>
      {isSenior && <SeniorBolt />}
    </span>}
    {vip && <span className="account-badge account-vip" data-vip-tier={vip.tier}>
      <VipEmblem tier={vip.tier} />
      <span>{vip.label}</span>
    </span>}
  </span>
}
