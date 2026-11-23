import { invoke, isTauri } from '@tauri-apps/api/core'
import { accountEpoch } from './accountScope'
import { isAndroid, isIOS, isOHOS } from './platform'

export type DiagnosticArea = 'playback' | 'video' | 'sync' | 'download' | 'startup'
export type DiagnosticStep =
  'resolve' | 'source' | 'media-ready' | 'start' | 'buffer' | 'decode' | 'quality-switch' | 'control' | 'recovery' | 'track-record' |
  'audio-focus' | 'media-key' | 'export' | 'transfer' | 'convert' | 'destination' | 'exchange' | 'backoff' |
  'database' | 'media-proxy' | 'native-ready' | 'webview-ready' | 'webview-process' | 'process-exit' | 'previous-startup'
export type DiagnosticOutcome = 'started' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type DiagnosticSource = 'online' | 'local-download' | 'cache' | 'linked-favorite' | 'collection' | 'playlist' | 'imported' | 'cloud' | 'webdav'
export type DiagnosticEngine = 'web-audio' | 'web-video' | 'android-media-player' | 'av-player' | 'ohos-avplayer' | 'webview2' | 'wk-webview'
export type DiagnosticDetails = {
  code?: string
  initialCode?: string
  bvid?: string
  cid?: number
  source?: DiagnosticSource
  origin?: DiagnosticSource
  engine?: DiagnosticEngine
  elapsedMs?: number
  codec?: string
  actualQuality?: number
  requestedQuality?: number
  http?: number
  bytes?: number
  domain?: 'library' | 'statistics'
}
export type DiagnosticEvent = DiagnosticDetails & { operation: string; area: DiagnosticArea; step: DiagnosticStep; outcome: DiagnosticOutcome }
export type DiagnosticRecord = { at: number; build?: string; event: DiagnosticEvent }

export const audioDiagnosticEngine = (): DiagnosticEngine =>
  isAndroid ? 'android-media-player' : isIOS ? 'av-player' : isOHOS ? 'ohos-avplayer' : 'web-audio'

export function diagnosticId() {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) return undefined
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => ('0' + byte.toString(16)).slice(-2)).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

async function scoped<T>(command: string, args: Record<string, unknown> = {}) {
  const epoch = accountEpoch()
  const expectedAccountSession = await invoke<string>('account_session')
  if (epoch !== accountEpoch()) throw new Error('账号已切换')
  const value = await invoke<T>(command, { ...args, expectedAccountSession })
  if (epoch !== accountEpoch()) throw new Error('账号已切换')
  return value
}

export function diagnosticsRecent(operation?: string, area?: DiagnosticArea) {
  return isTauri() ? scoped<DiagnosticRecord[]>('diagnostics_recent', { operation, area }) : Promise.resolve([])
}

export const clearDiagnostics = () => scoped<void>('diagnostics_clear')
export const saveDiagnosticsReport = (operation?: string, area?: DiagnosticArea) => scoped<boolean>('diagnostics_save_report', { operation, area })

export function startDiagnosticTrace(area: 'playback' | 'video', details: DiagnosticDetails, id?: string) {
  const operation = id ?? diagnosticId()
  const epoch = accountEpoch()
  const started = Date.now()
  const session = isTauri() && operation ? invoke<string>('account_session').catch(() => undefined) : undefined
  let context = { ...details }
  return {
    operation,
    get context() { return context },
    get valid() { return epoch === accountEpoch() },
    update(details: DiagnosticDetails) { context = { ...context, ...details } },
    emit(step: DiagnosticStep, outcome: DiagnosticOutcome, details?: DiagnosticDetails) {
      if (!operation || !session || epoch !== accountEpoch()) return
      const event: DiagnosticEvent = { ...context, ...details, operation, area, step, outcome, elapsedMs: Math.max(0, Date.now() - started) }
      void session.then(expectedAccountSession => {
        if (expectedAccountSession && epoch === accountEpoch()) {
          return invoke('diagnostics_record', { event, expectedAccountSession })
        }
      }).catch(() => undefined)
    },
  }
}

export function installStartupDiagnostics() {
  if (!isTauri()) return () => undefined
  const operation = diagnosticId()
  const reported = new Set<string>()
  const record = (code: string) => {
    if (reported.has(code)) return
    reported.add(code)
    if (operation) void invoke('diagnostics_record', {
      event: { operation, area: 'startup', step: 'webview-ready', outcome: 'failed', code },
    }).catch(() => undefined)
  }
  window.addEventListener('error', event => { if (event instanceof ErrorEvent) record('script_error') })
  window.addEventListener('unhandledrejection', () => record('promise_rejection'))
  let ready = false
  return () => {
    if (ready) return
    ready = true
    void invoke('diagnostics_ready').catch(() => undefined)
  }
}
