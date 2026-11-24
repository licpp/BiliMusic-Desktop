import { invoke } from '@tauri-apps/api/core'

export type BiliPause = {
  reason: 'rateLimited' | 'verificationRequired' | 'authRequired'
  retryAt?: number
}

export function biliRequestPause(error: unknown): BiliPause | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return
  switch (error.code) {
    case 'bili_rate_limited':
      return {
        reason: 'rateLimited',
        retryAt: 'retryAt' in error && typeof error.retryAt === 'number' && Number.isFinite(error.retryAt) ? error.retryAt : undefined,
      }
    case 'bili_verification_required': return { reason: 'verificationRequired' }
    case 'bili_auth_required': return { reason: 'authRequired' }
  }
}

export function biliPauseMessage({ reason, retryAt }: BiliPause, now = Date.now()) {
  if (reason === 'verificationRequired') return '请前往 B 站完成验证'
  if (reason === 'authRequired') return '请重新登录 B 站'
  if (!retryAt || retryAt <= now) return 'B 站暂时限制了请求，可重试'
  const date = new Date(retryAt)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const day = date.toDateString() === new Date(now).toDateString() ? '' : date.toLocaleDateString('zh-CN') + ' '
  return `B 站暂时限制了请求 · ${day}${time} 后可重试`
}

export const openBiliVerification = () => invoke<void>('bili_open_verification_page')

export const retryOnceUnlessBiliPaused = (failures: number, error: unknown) => failures < 1 && !biliRequestPause(error)

export const isUnavailableBiliVideo = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
  && (error.code === 'source_unavailable' || error.code === 'source_expired'))
