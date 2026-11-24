import { useEffect, useState } from 'react'
import { Activity, Copy, Download, RefreshCw, Trash2 } from 'lucide-react'
import { isTauri } from '@tauri-apps/api/core'
import { accountEpoch } from '../../services/accountScope'
import { clearDiagnostics, diagnosticsRecent, saveDiagnosticsReport, type DiagnosticArea, type DiagnosticRecord, type DiagnosticStep } from '../../services/diagnostics'
import { formatDiagnosticEnvironment, readDiagnosticEnvironment, type DiagnosticEnvironment } from '../../services/diagnosticEnvironment'
import { isMobile } from '../../services/platform'
import { copyText } from '../../shared/copyText'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { currentDisplayVersion } from '../../shared/version'
import { LargeDialog } from '../../large-screen/LargeDialog'

const areas: Record<DiagnosticArea, string> = { playback: '播放', video: '视频', download: '下载', sync: '同步', startup: '启动' }

const steps: Record<DiagnosticStep, string> = {
  resolve: '解析曲目', source: '获取媒体源', 'media-ready': '首批媒体数据可解码',
  start: '起播', buffer: '缓冲', decode: '解码', 'quality-switch': '切换音质', control: '播放控制', recovery: '恢复播放',
  'track-record': '本地曲目记录', 'audio-focus': '音频焦点', 'media-key': '媒体控制',
  export: '保存到下载目录', transfer: '传输', convert: '转码', destination: '检查保存位置',
  exchange: '同步交换', backoff: '退避', database: '本地数据库', 'media-proxy': '本地媒体代理',
  'native-ready': '原生服务', 'webview-ready': '界面启动', 'webview-process': 'WebView 进程',
  'process-exit': '应用进程退出', 'previous-startup': '上次启动',
}

const outcomes = { started: '开始', succeeded: '完成', failed: '异常', cancelled: '取消', skipped: '跳过' }
const keyOf = (record: DiagnosticRecord, index: number) => `${record.event.operation}:${record.at}:${index}`

export function DiagnosticsViewer({ onClose, large = false, operation, initialArea }: { onClose: () => void; large?: boolean; operation?: string; initialArea?: DiagnosticArea }) {
  const [area, setArea] = useState<DiagnosticArea | undefined>(initialArea)
  const [revision, reload] = useState(0)
  const [records, setRecords] = useState<DiagnosticRecord[]>()
  const [environment, setEnvironment] = useState<DiagnosticEnvironment>()
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [trace, setTrace] = useState(operation)
  useEffect(() => {
    let alive = true
    void readDiagnosticEnvironment().then(value => { if (alive) setEnvironment(value) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const close = () => { setRecords(undefined); onClose() }
    window.addEventListener('bilimusic-account-changing', close)
    return () => window.removeEventListener('bilimusic-account-changing', close)
  }, [onClose])
  useEffect(() => {
    let alive = true
    setRecords(undefined)
    setError('')
    void diagnosticsRecent(trace, area).then(value => {
      if (alive) setRecords(value)
    }, () => { if (alive) setError('暂时无法读取记录') })
    return () => { alive = false }
  }, [trace, area, revision])

  const report = () => JSON.stringify({ schemaVersion: 1, version: currentDisplayVersion, environment, exportedAt: new Date().toISOString(), records: records?.slice().reverse() }, null, 2)
  const copy = async () => {
    const epoch = accountEpoch()
    try {
      await copyText(report())
      if (epoch === accountEpoch()) setNotice('诊断已复制')
    } catch {
      if (epoch === accountEpoch()) setNotice('复制失败，请重试')
    }
  }
  const save = async () => {
    const epoch = accountEpoch()
    try {
      if (await saveDiagnosticsReport(trace, area) && epoch === accountEpoch()) setNotice('诊断已保存')
    } catch {
      if (epoch === accountEpoch()) setNotice('无法保存诊断，请重试')
    }
  }
  const clear = async () => {
    setBusy(true)
    const epoch = accountEpoch()
    try {
      await clearDiagnostics()
      if (epoch !== accountEpoch()) return
      setConfirm(false)
      setTrace(undefined)
      reload(value => value + 1)
      setNotice('诊断已清空')
    } catch {
      if (epoch === accountEpoch()) setNotice('无法清空记录，请重试')
    } finally {
      if (epoch === accountEpoch()) setBusy(false)
    }
  }
  const Dialog = large ? LargeDialog : CollectionDialog
  return <Dialog title="诊断记录" onClose={onClose} className="diagnostics-dialog">
    <p className="diagnostics-environment">{environment ? [`BiliMusic ${currentDisplayVersion}`, environment.system, environment.webview].join(' · ') : '正在读取设备信息…'}</p>
    <div className="diagnostics-filters" aria-label="诊断类别">
      {([undefined, ...Object.keys(areas)] as (DiagnosticArea | undefined)[]).map(filter =>
        <button type="button" key={filter ?? 'all'} aria-pressed={filter === area && !trace} onClick={() => { setTrace(undefined); setArea(filter); setNotice('') }}>{filter ? areas[filter] : '全部'}</button>)}
      {trace && <span>单次诊断 · {trace.slice(0, 8)}</span>}
    </div>
    <div className="diagnostics-timeline" tabIndex={0} aria-label="诊断时间线">
      {error ? <p role="alert">{error}</p> : !records ? <p role="status">正在读取记录…</p> : !records.length ? <p>暂无诊断记录</p> :
        <ul>{records.map((record, index) => {
          const { at, event } = record
          return <li key={keyOf(record, index)} data-outcome={event.outcome}>
            <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
            <div><strong>{areas[event.area]} · {steps[event.step]}</strong>
              <small>{[event.code, event.bvid, event.cid && `CID ${event.cid}`, event.elapsedMs === undefined ? '' : `${event.elapsedMs} ms`].filter(Boolean).join(' · ')}</small>
              {trace && <small>{[
                event.initialCode && event.initialCode !== event.code && `首次错误 ${event.initialCode}`,
                record.build && record.build !== currentDisplayVersion && `版本 ${record.build}`,
                event.engine, event.source, event.codec, event.http && `HTTP ${event.http}`,
                event.actualQuality && `音质 ${event.actualQuality}`, event.bytes && `${(event.bytes / 1024).toFixed(1)} KB`,
              ].filter(Boolean).join(' · ')}</small>}
            </div>
            {trace ? <span>{outcomes[event.outcome]}</span> : <button type="button" onClick={() => { setArea(undefined); setTrace(event.operation); setNotice('') }} aria-label={`查看${areas[event.area]}诊断 ${event.operation.slice(0, 8)}`}>{outcomes[event.outcome]}</button>}
          </li>
        })}</ul>}
    </div>
    {confirm ? <div className="diagnostics-actions"><span>清空本机诊断记录？</span><button type="button" disabled={busy} onClick={() => setConfirm(false)}>取消</button><button type="button" disabled={busy} onClick={() => void clear()}>清空</button></div> :
      <div className="diagnostics-actions">
        <button type="button" onClick={() => { setNotice(''); reload(value => value + 1) }} aria-label="刷新记录"><RefreshCw/></button>
        <button type="button" disabled={!records?.length} onClick={() => setConfirm(true)} aria-label="清空记录"><Trash2/></button>
        <button type="button" disabled={!records?.length || !environment} onClick={() => void copy()}><Copy/>复制报告</button>
        {!isMobile && <button type="button" disabled={!records?.length || !environment} onClick={() => void save()}><Download/>保存报告</button>}
      </div>}
    {notice && <p className="diagnostics-notice" role="status">{notice}</p>}
  </Dialog>
}

export function DiagnosticsSettings({ large = false }: { large?: boolean }) {
  const [open, setOpen] = useState(false)
  const [environment, setEnvironment] = useState<DiagnosticEnvironment>()
  const [copied, setCopied] = useState('')
  const app = isTauri()
  useEffect(() => {
    if (!app) return
    let active = true
    void readDiagnosticEnvironment().then(value => { if (active) setEnvironment(value) })
    return () => { active = false }
  }, [app])
  if (!app) return null
  const copyEnvironment = async () => {
    if (!environment) return
    try {
      await copyText(formatDiagnosticEnvironment(currentDisplayVersion, environment))
      setCopied('设备环境已复制')
    } catch { setCopied('复制失败，请重试') }
  }
  return <section className="settings-card" aria-label="诊断记录">
    <div className="settings-icon"><Activity/></div><div><strong>诊断记录</strong><small>播放、下载、同步与启动</small></div>
    <div className="diagnostics-settings-actions">
      <button type="button" onClick={() => setOpen(true)}>查看记录</button>
      <button type="button" disabled={!environment} onClick={() => void copyEnvironment()}>复制设备环境</button>
    </div>
    {copied && <small className="diagnostics-settings-feedback" role="status">{copied}</small>}
    {open && <DiagnosticsViewer large={large} onClose={() => setOpen(false)}/>}
  </section>
}
