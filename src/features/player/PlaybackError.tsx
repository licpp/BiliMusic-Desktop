import { useEffect, useState } from 'react'
import { accountEpoch } from '../../services/accountScope'
import { readDiagnosticEnvironment, type DiagnosticEnvironment } from '../../services/diagnosticEnvironment'
import { currentDisplayVersion } from '../../shared/version'
import type { Track } from '../../domain/track'
import { isLargeScreen } from '../../services/platform'
import { DiagnosticsViewer } from '../settings/DiagnosticsSettings'
import { copyText } from '../../shared/copyText'
import { playbackDiagnosticText, playbackIssueSummary, type PlaybackIssue } from './playbackIssue'

export function PlaybackErrorText({ issue }: { issue: PlaybackIssue }) {
  return <div className="playback-issue-text">
    <span>{issue.message}</span>
    <small>{playbackIssueSummary(issue)}</small>
  </div>
}

export function CopyPlaybackDiagnostics({ issue, track, codecs }: { issue: PlaybackIssue; track?: Track | null; codecs?: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState('')
  const [environment, setEnvironment] = useState<DiagnosticEnvironment>()
  useEffect(() => {
    // Load native details before the click so WebKit can write during the clipboard gesture.
    let mounted = true
    void readDiagnosticEnvironment().then(value => { if (mounted) setEnvironment(value) })
    return () => { mounted = false }
  }, [])
  const key = JSON.stringify([issue.stage, issue.code, track?.id, codecs, issue.occurredAt])
  const copy = async () => {
    if (!environment) return
    const epoch = accountEpoch()
    try {
      await copyText(playbackDiagnosticText(issue, {
        version: currentDisplayVersion, environment, codecs: issue.diagnostic?.codec ?? codecs,
        bvid: issue.diagnostic?.bvid ?? track?.source.bvid, cid: issue.diagnostic?.cid ?? track?.source.cid,
        playbackSource: issue.diagnostic?.origin,
      }))
      if (epoch === accountEpoch()) setCopied(key)
    } catch {
      if (epoch === accountEpoch()) setCopied(`failed:${key}`)
    }
  }
  return <><button type="button" disabled={!environment} onClick={() => void copy()}>
    {copied === key ? '已复制' : copied === `failed:${key}` ? '复制失败，重试' : '复制诊断'}
  </button>{issue.diagnostic?.operation && <button type="button" onClick={() => setOpen(true)}>诊断记录</button>}
    {open && <DiagnosticsViewer large={isLargeScreen} operation={issue.diagnostic?.operation} onClose={() => setOpen(false)}/>}
  </>
}
