import { getVideoSource } from '../../services/desktopApi'
import { startDiagnosticTrace } from '../../services/diagnostics'
import { playbackDiagnosticStep, playbackIssue, type PlaybackIssue } from '../player/playbackIssue'

export type VideoDiagnosticTrace = ReturnType<typeof videoDiagnosticTrace>
export const videoDiagnosticTrace = (bvid: string, cid: number) =>
  startDiagnosticTrace('video', { bvid, cid, source: 'online', engine: 'web-video' })

export function reportVideoIssue(trace: VideoDiagnosticTrace, issue: PlaybackIssue) {
  trace.emit(playbackDiagnosticStep(issue), 'failed', { code: issue.code, initialCode: issue.initialCode })
  return { ...issue, diagnostic: { ...trace.context, operation: trace.operation } }
}

export class DiagnosticVideoError extends Error {
  constructor(readonly issue: PlaybackIssue) { super(issue.message) }
}
export const videoSourceIssue = (cause: unknown) => cause instanceof DiagnosticVideoError ? cause.issue :
  playbackIssue('video-source', cause, '暂时无法获取视频线路')

export async function getDiagnosticVideoSource(bvid: string, cid: number, refresh = false, compatible = false, trace = videoDiagnosticTrace(bvid, cid)) {
  trace.emit(refresh ? 'recovery' : 'source', 'started')
  try {
    const source = await getVideoSource(bvid, cid, refresh, compatible)
    trace.update({ codec: source.codecs })
    trace.emit('source', 'succeeded')
    return { ...source, diagnostic: trace }
  } catch (error) {
    const issue = reportVideoIssue(trace, playbackIssue('video-source', error, '暂时无法获取视频线路'))
    if (refresh) trace.emit('recovery', 'failed', { code: issue.code })
    throw new DiagnosticVideoError(issue)
  }
}
