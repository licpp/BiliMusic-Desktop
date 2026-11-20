import { commandErrorMessage } from '../../services/userErrors'

const stageLabels = {
  account: '播放账号检查',
  'audio-source': '获取音源',
  'audio-start': '启动音频',
  'audio-playback': '音频播放',
  'audio-buffer': '音频缓冲',
  'audio-decode': '音频解码',
  'audio-control': '播放控制',
  'video-source': '获取视频线路',
  'video-start': '启动视频',
  'video-buffer': '视频缓冲',
  'video-decode': '视频解码',
}

type PlaybackStage = keyof typeof stageLabels
export type PlaybackIssue = { stage: PlaybackStage; message: string; code?: string; occurredAt: string }

const codes = new Set([
  'account_changed', 'profile_unavailable', 'native_not_ready', 'native_request_failed',
  'source_timeout', 'source_unavailable', 'invalid_source', 'audio_stalled', 'video_stalled',
  'audio_focus_denied', 'audio_prepare_failed', 'duration_unavailable', 'autoplay_blocked',
  'provider_error', 'database_error', 'invalid_input', 'offline_unavailable',
])
const systemCode = /^(?:android_media:-?\d{1,10}:-?\d{1,10}|ios_media:(?:NSURLErrorDomain|NSOSStatusErrorDomain|NSPOSIXErrorDomain|AVFoundationErrorDomain|CoreMediaErrorDomain|other):-?\d{1,16}|ohos_media:-?\d{1,16}|html_media:[1-4])$/

export function playbackIssue(stage: PlaybackStage, cause: unknown, fallback: string, nativeCode?: string): PlaybackIssue {
  const reported = nativeCode ?? (cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined)
  const knownCode = typeof reported === 'string' && (codes.has(reported) || systemCode.test(reported)) ? reported : undefined
  const raw = typeof cause === 'string' ? cause : cause && typeof cause === 'object' && 'message' in cause &&
    typeof cause.message === 'string' ? cause.message : ''
  const biliStatus = raw.match(/^Bilibili 接口返回错误 (-?\d{1,8}):/)?.[1]
  const httpStatus = raw.match(/\bHTTP\s+([345]\d{2})\b/i)?.[1]
  const code = biliStatus ? `bili_api:${biliStatus}` : httpStatus ? `http:${httpStatus}` : knownCode
  const message = commandErrorMessage(cause, fallback)
  if (knownCode === 'account_changed' || knownCode === 'profile_unavailable' || /播放账号已变更/.test(message)) stage = 'account'
  else if (knownCode === 'audio_stalled') stage = 'audio-buffer'
  else if (knownCode === 'source_unavailable' || knownCode === 'source_timeout' || knownCode === 'invalid_source') stage = 'audio-source'
  else if (stage === 'audio-playback' && (knownCode === 'provider_error' || knownCode === 'database_error' || knownCode === 'invalid_input')) stage = 'audio-source'
  else if (knownCode === 'native_not_ready' || knownCode === 'audio_focus_denied' ||
      knownCode === 'audio_prepare_failed' || knownCode === 'duration_unavailable') stage = 'audio-start'
  else if (knownCode?.startsWith('android_media:') && /解码|本地音频无法播放/.test(message)) stage = 'audio-decode'
  else if (knownCode?.startsWith('android_media:') && /:(?:-1004|-110)(?::|$)/.test(knownCode)) stage = 'audio-buffer'
  else if (knownCode?.startsWith('ios_media:NSURLErrorDomain:')) stage = 'audio-buffer'
  return { stage, message, code, occurredAt: new Date().toISOString() }
}

export function playbackIssueSummary(issue: PlaybackIssue) {
  return [stageLabels[issue.stage], issue.code].filter(Boolean).join(' · ')
}

export function playbackDiagnosticText(issue: PlaybackIssue, context: {
  version: string; platform: string; bvid?: string; cid?: number; codecs?: string; webView?: string
}) {
  return [
    `BiliMusic ${context.version} · ${context.platform}`,
    issue.occurredAt,
    `阶段 ${issue.stage}`,
    issue.code && `错误码 ${issue.code}`,
    /^BV[0-9a-zA-Z]{10}$/.test(context.bvid ?? '') && `BV ${context.bvid}`,
    typeof context.cid === 'number' && Number.isSafeInteger(context.cid) && context.cid > 0 && `CID ${context.cid}`,
    /^(?:avc[13]|hev1|hvc1|av01|vp09)[.0-9a-zA-Z]{0,32}$/.test(context.codecs ?? '') && `编码 ${context.codecs}`,
    /^\d{2,3}(?:\.\d{1,5}){1,3}$/.test(context.webView ?? '') && `Chromium ${context.webView}`,
  ].filter(Boolean).join('\n')
}
