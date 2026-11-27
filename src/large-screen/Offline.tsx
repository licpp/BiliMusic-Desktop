import { accountQueryKey } from '../services/queryKeys'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RotateCw, Trash2 } from 'lucide-react'
import { listDownloads, commandErrorMessage } from '../services/desktopApi'
import { isAndroid } from '../services/platform'
import { useDownloadBatch } from '../features/downloads/downloadBatch'
import { chooseDownload } from '../features/downloads/downloadRequest'
import {
  canRemoveDownload, canRetryDownload, DownloadRemovalDetails, DownloadSelectButton, DownloadSelectionControls,
  downloadTitle, useDownloadRemoval,
} from '../features/downloads/DownloadRemoval'
import { formatDuration } from '../shared/time'
import { Artwork } from '../shared/Artwork'
import { useListRows } from '../shared/useListRows'
import { usePlayerStore } from '../features/player/playerStore'
import { Empty, Failure } from './Library'
import { DiagnosticsViewer } from '../features/settings/DiagnosticsSettings'
import { LargeDialog } from './LargeDialog'

export function LargeOffline() {
  const batch = useDownloadBatch(s => s.batch), busy = useDownloadBatch(s => s.busy)
  const downloads = useQuery({
    queryKey: accountQueryKey('downloads'), queryFn: listDownloads, networkMode: 'always',
    refetchOnMount: 'always', refetchOnWindowFocus: 'always',
    refetchInterval: query => busy || query.state.data?.some(record => record.status === 'queued' || record.status === 'downloading') ? 3000 : false,
  })
  const [diagnostics, setDiagnostics] = useState(false)
  const records = downloads.data || []
  const removal = useDownloadRemoval(records)
  const rendered = useListRows(records, 'large-downloads', { manualFallback: true })
  const complete = useMemo(() => [...new Map((downloads.data || []).flatMap(record =>
    record.status === 'completed' && record.track ? [[record.trackId, record.track] as const] : []
  )).values()], [downloads.data])
  return <>
    <div className="large-section-heading download-heading">
      <h2>离线音乐 <small className="large-muted">{complete.length} 首</small></h2>
      <DownloadSelectionControls removal={removal}/>
    </div>
    {busy && batch && <p className="large-muted" role="status">正在下载 {batch.completed + batch.skipped} / {batch.total}</p>}
    <Failure error={downloads.error} retry={() => void downloads.refetch()}/>
    {rendered.rows.map(record => {
      const track = record.track
      const title = downloadTitle(record)
      const canRemove = canRemoveDownload(record)
      const retryable = canRetryDownload(record)
      const selecting = removal.selecting && canRemove
      const status = record.status === 'completed' ? track ? formatDuration(track.durationSeconds) : '已下载'
        : retryable ? commandErrorMessage(record.errorMessage, record.status === 'missing' ? '文件已丢失' : '下载失败')
        : record.status === 'queued' ? '等待下载'
        : Math.round(record.receivedBytes / Math.max(1, record.totalBytes || record.receivedBytes) * 100) + '%'
      const content = <>
        <span className="large-track-art"><Artwork adaptAspect src={track?.coverUrl}/></span>
        <span className="large-track-copy"><strong>{title}</strong><small>{status}</small></span>
      </>
      return <div className="large-offline-row" key={record.id} data-download-selected={selecting && removal.ids.has(record.id) || undefined}
        onClick={selecting ? () => removal.toggle(record.id) : undefined}>
        {removal.selecting ? <>
          <div className="large-track-main">{content}</div>
          {canRemove && <DownloadSelectButton record={record} removal={removal}/>}
        </> : <>
          <button type="button" className="large-track-main" disabled={!track || record.status !== 'completed'} onClick={() => { if (track) void usePlayerStore.getState().playFromList(complete, track.id) }}>
            {content}
          </button>
          {retryable && track && <button type="button" aria-label={'重新下载' + title} disabled={busy} onClick={() => chooseDownload([track])}><RotateCw/></button>}
          <button type="button" disabled={!canRemove} className="large-icon" aria-label={'删除' + title} onClick={() => removal.request([record])}><Trash2/></button>
        </>}
      </div>
    })}
    {batch && batch.failures.length > 0 && <button className="large-text-button" onClick={() => setDiagnostics(true)}>下载诊断</button>}
    {diagnostics && <DiagnosticsViewer large initialArea="download" onClose={() => setDiagnostics(false)}/>}
    {rendered.manualMore ? <div ref={rendered.tail}><button className="large-text-button" onClick={rendered.manualMore}>加载更多</button></div>
      : rendered.more && <div ref={rendered.tail} className="large-offline-tail" aria-hidden="true"/>}
    {!downloads.isPending && !records.length && <Empty>歌曲的更多菜单中可以下载音乐</Empty>}
    {removal.pending && <LargeDialog title="删除下载" onClose={removal.cancel} className="download-removal-dialog">
      <DownloadRemovalDetails removal={removal} keepsExportedFiles={isAndroid}/>
      <div className="large-options">
        <button type="button" disabled={removal.removing} onClick={removal.cancel}>取消</button>
        <button type="button" className="action-danger" disabled={removal.removing} onClick={() => void removal.confirm()}>{removal.removing ? '正在删除…' : '删除'}</button>
      </div>
    </LargeDialog>}
  </>
}
