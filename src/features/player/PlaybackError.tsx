import { useState } from 'react'
import { accountEpoch } from '../../services/accountScope'
import { isAndroid, isIOS, isLargeScreen, isOHOS } from '../../services/platform'
import { currentDisplayVersion } from '../../shared/version'
import type { Track } from '../../domain/track'
import { playbackDiagnosticText, playbackIssueSummary, type PlaybackIssue } from './playbackIssue'

export function PlaybackErrorText({ issue }: { issue: PlaybackIssue }) {
  return <div className="playback-issue-text">
    <span>{issue.message}</span>
    <small>{playbackIssueSummary(issue)}</small>
  </div>
}

async function copyDiagnosticText(text: string) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch { /* Some app WebViews restrict the async clipboard API. */ }
  }
  const previous = document.activeElement
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.append(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    field.setSelectionRange(0, text.length)
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable')
  } finally {
    field.remove()
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true })
  }
}

export function CopyPlaybackDiagnostics({ issue, track, codecs }: { issue: PlaybackIssue; track?: Track | null; codecs?: string }) {
  const [copied, setCopied] = useState('')
  const key = JSON.stringify([issue.stage, issue.code, track?.id, codecs, issue.occurredAt])
  const copy = async () => {
    const epoch = accountEpoch()
    const ua = navigator.userAgent
    const androidVersion = ua.match(/\bAndroid (\d{1,2}(?:\.\d{1,2}){0,2})\b/)?.[1]
    const platform = isAndroid ? ['Android', androidVersion, isLargeScreen ? '车机版' : ''].filter(Boolean).join(' ')
      : isOHOS ? 'HarmonyOS' : isIOS ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : '桌面端'
    try {
      await copyDiagnosticText(playbackDiagnosticText(issue, {
        version: currentDisplayVersion, platform, codecs, bvid: track?.source.bvid, cid: track?.source.cid,
        webView: ua.match(/\bChrome\/([\d.]+)/)?.[1],
      }))
      if (epoch === accountEpoch()) setCopied(key)
    } catch {
      if (epoch === accountEpoch()) setCopied(`failed:${key}`)
    }
  }
  return <button type="button" onClick={() => void copy()}>
    {copied === key ? '已复制' : copied === `failed:${key}` ? '复制失败，重试' : '复制诊断'}
  </button>
}
