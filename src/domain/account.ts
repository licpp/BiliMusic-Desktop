export type QrLogin = { key: string; url: string }
export type QrLoginStatus = { status: 'waiting' | 'confirmed' | 'authenticated' | 'expired' | 'error'; message: string }
export type VipTier = 'vip' | 'annual' | 'ten_annual' | 'hundred_annual'
export type AccountProfile = {
  loggedIn: boolean
  userId?: number
  name?: string
  avatarUrl?: string
  level?: number
  seniorMember?: boolean
  vipActive?: boolean
  vipType?: number
  vipTheme?: string
  vipLabel?: string
}

export function resolveVipBadge(
  profile?: Pick<AccountProfile, 'vipActive' | 'vipType' | 'vipTheme' | 'vipLabel'>,
): { tier: VipTier; label: string } | null {
  if (!profile?.vipActive) return null
  const theme = (profile.vipTheme || '').trim().toLowerCase()
  const rawLabel = (profile.vipLabel || '').trim()
  if (theme.includes('hundred_annual') || rawLabel.includes('百年')) {
    return { tier: 'hundred_annual', label: rawLabel || '百年大会员' }
  }
  if (theme.includes('ten_annual') || rawLabel.includes('十年')) {
    return { tier: 'ten_annual', label: rawLabel || '十年大会员' }
  }
  if (theme === 'annual_vip' || rawLabel.includes('年度') || profile.vipType === 2) {
    return { tier: 'annual', label: rawLabel || '年度大会员' }
  }
  return { tier: 'vip', label: rawLabel || '大会员' }
}
