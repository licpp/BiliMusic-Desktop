import type { DiagnosticDetails, DiagnosticStep } from '../../services/diagnostics'
import { commandErrorMessage } from '../../services/userErrors'
import { formatDiagnosticEnvironment, type DiagnosticEnvironment } from '../../services/diagnosticEnvironment'

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
export type PlaybackIssue = { stage: PlaybackStage; message: string; code?: string; initialCode?: string; occurredAt: string; diagnostic?: DiagnosticDetails & { operation?: string } }

const codes = new Set([
  'account_changed', 'profile_unavailable', 'native_not_ready', 'native_request_failed',
  'source_timeout', 'source_unavailable', 'invalid_source', 'audio_stalled', 'video_stalled',
  'audio_focus_denied', 'audio_prepare_failed', 'duration_unavailable', 'autoplay_blocked',
  'provider_error', 'database_error', 'invalid_input', 'offline_unavailable', 'source_expired', 'track_missing', 'cid_mismatch', 'proxy_unavailable',
])
const systemCode = /^(?:android_media:-?\d{1,10}:-?\d{1,10}|ios_media:(?:NSURLErrorDomain|NSOSStatusErrorDomain|NSPOSIXErrorDomain|AVFoundationErrorDomain|CoreMediaErrorDomain|other):-?\d{1,16}|ohos_media:-?\d{1,16}|html_media:[1-4])$/

export function playbackIssue(stage: PlaybackStage, cause: unknown, fallback: string, nativeCode?: string, initialCode?: string): PlaybackIssue {
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
  else if (knownCode === 'source_unavailable' || knownCode === 'source_timeout' || knownCode === 'invalid_source' || knownCode === 'track_missing' || knownCode === 'cid_mismatch' || knownCode === 'proxy_unavailable') stage = 'audio-source'
  else if (stage === 'audio-playback' && (knownCode === 'provider_error' || knownCode === 'database_error' || knownCode === 'invalid_input')) stage = 'audio-source'
  else if (knownCode === 'native_not_ready' || knownCode === 'audio_focus_denied' ||
      knownCode === 'audio_prepare_failed' || knownCode === 'duration_unavailable') stage = 'audio-start'
  else if (knownCode?.startsWith('android_media:') && /解码|本地音频无法播放/.test(message)) stage = 'audio-decode'
  else if (knownCode?.startsWith('android_media:') && /:(?:-1004|-110)(?::|$)/.test(knownCode)) stage = 'audio-buffer'
  else if (knownCode?.startsWith('ios_media:NSURLErrorDomain:')) stage = 'audio-buffer'
  return { stage, message, code, ...(initialCode && initialCode !== code && systemCode.test(initialCode) ? { initialCode } : {}), occurredAt: new Date().toISOString() }
}

export function playbackDiagnosticStep(issue: PlaybackIssue): DiagnosticStep {
  switch (issue.stage) {
    case 'account': case 'audio-source': case 'video-source': return 'source'
    case 'audio-start': case 'video-start': return 'start'
    case 'audio-buffer': case 'video-buffer': return 'buffer'
    case 'audio-decode': case 'video-decode': return 'decode'
    default: return 'control'
  }
}

export function playbackIssueSummary(issue: PlaybackIssue) {
  return [stageLabels[issue.stage], issue.code].filter(Boolean).join(' · ')
}

export function playbackDiagnosticText(issue: PlaybackIssue, context: {
  version: string; environment: DiagnosticEnvironment; bvid?: string; cid?: number; codecs?: string; playbackSource?: string
}) {
  const { environment } = context
  const bvid = issue.diagnostic ? issue.diagnostic.bvid : context.bvid
  const cid = issue.diagnostic ? issue.diagnostic.cid : context.cid
  const codecs = issue.diagnostic?.codec ?? context.codecs
  return [
    `BiliMusic ${context.version}${environment.largeScreen ? ' · 车机 / TV' : ''}`,
    issue.occurredAt,
    issue.diagnostic?.operation && `诊断编号 ${issue.diagnostic.operation}`,
    issue.diagnostic?.engine && `播放器 ${issue.diagnostic.engine}`,
    issue.diagnostic?.source && `音视频来源 ${issue.diagnostic.source}`,
    `阶段 ${issue.stage}`,
    issue.code && `错误码 ${issue.code}`,
    issue.initialCode && `首次播放错误 ${issue.initialCode}`,
    context.playbackSource && `播放来源 ${context.playbackSource}`,
    /^BV[0-9a-zA-Z]{10}$/.test(bvid ?? '') && `BV ${bvid}`,
    typeof cid === 'number' && Number.isSafeInteger(cid) && cid > 0 && `CID ${cid}`,
    /^(?:avc[13]|hev1|hvc1|av01|vp09|mp4a|flac|fLaC|opus|ac-3|ec-3)[.0-9a-zA-Z]{0,32}$/.test(codecs ?? '') && `编码 ${codecs}`,
    formatDiagnosticEnvironment(context.version, environment).split('\n').slice(1).join('\n'),
  ].filter(Boolean).join('\n')
}
