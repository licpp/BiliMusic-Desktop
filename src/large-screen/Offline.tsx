import { accountQueryKey } from '../services/queryKeys'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCw, Trash2 } from 'lucide-react'
import { listDownloads, removeDownload, commandErrorMessage } from '../services/desktopApi'
import { useDownloadBatch } from '../features/downloads/downloadBatch'
import { chooseDownload } from '../features/downloads/downloadRequest'
import { formatDuration } from '../shared/time'
import { Artwork } from '../shared/Artwork'
import { useListRows } from '../shared/useListRows'
import { usePlayerStore } from '../features/player/playerStore'
import { Empty, Failure } from './Library'
import { DiagnosticsViewer } from '../features/settings/DiagnosticsSettings'
import { LargeDialog } from './LargeDialog'

export function LargeOffline() {
  const client = useQueryClient()
  const batch = useDownloadBatch(s => s.batch), busy = useDownloadBatch(s => s.busy)
  const downloads = useQuery({
    queryKey: accountQueryKey('downloads'), queryFn: listDownloads, networkMode: 'always',
    refetchInterval: query => busy || query.state.data?.some(record => record.status === 'queued' || record.status === 'downloading') ? 3000 : false,
  })
  const [diagnostics, setDiagnostics] = useState(false)
  const [error, setError] = useState(''), [removing, setRemoving] = useState<string>()
  const records = downloads.data || []
  const rendered = useListRows(records, 'large-downloads', { manualFallback: true })
  const complete = useMemo(() => [...new Map((downloads.data || []).flatMap(record =>
    record.status === 'completed' && record.track ? [[record.trackId, record.track] as const] : []
  )).values()], [downloads.data])
  return <>
    <div className="large-section-heading"><h2>离线音乐</h2><span className="large-muted">{complete.length} 首</span></div>
    {busy && batch && <p className="large-muted" role="status">正在下载 {batch.completed + batch.skipped} / {batch.total}</p>}
    <Failure error={downloads.error || error} retry={() => { setError(''); void downloads.refetch() }}/>
    {rendered.rows.map(record => {
      const track = record.track
      const status = record.status === 'completed' ? track ? formatDuration(track.durationSeconds) : '已下载'
        : record.status === 'failed' ? record.errorMessage || '下载失败'
        : record.status === 'queued' ? '等待下载'
        : `${Math.round(record.receivedBytes / Math.max(1, record.totalBytes || record.receivedBytes) * 100)}%`
      return <div className="large-offline-row" key={record.id}>
        <button className="large-track-main" disabled={!track || record.status !== 'completed'} onClick={() => { if (track) void usePlayerStore.getState().playFromList(complete, track.id) }}>
          <span className="large-track-art"><Artwork adaptAspect src={track?.coverUrl}/></span>
          <span><strong>{track?.displayTitle || track?.title || '音乐文件'}</strong><small>{status}</small></span>
        </button>
        {record.status === 'failed' && track && <button aria-label={`重新下载${track.title}`} disabled={busy} onClick={() => chooseDownload([track])}><RotateCw/></button>}
        <button disabled={record.status === 'downloading' || record.status === 'queued'} className="large-icon" aria-label={`删除${track?.title || '下载文件'}`} onClick={() => setRemoving(record.id)}><Trash2/></button>
      </div>
    })}
    {batch && batch.failures.length > 0 && <button className="large-text-button" onClick={() => setDiagnostics(true)}>下载诊断</button>}
    {diagnostics && <DiagnosticsViewer large initialArea="download" onClose={() => setDiagnostics(false)}/>}
    {rendered.manualMore ? <div ref={rendered.tail}><button className="large-text-button" onClick={rendered.manualMore}>加载更多</button></div> : rendered.more && <div ref={rendered.tail} className="large-offline-tail" aria-hidden="true"/>}
    {!downloads.isPending && !records.length && <Empty>歌曲的更多菜单中可以下载音乐</Empty>}
    {removing && <LargeDialog title="删除离线副本？" onClose={() => setRemoving(undefined)}>
      <p>音乐库中的歌曲会保留。</p>
      <div className="large-options"><button onClick={() => setRemoving(undefined)}>取消</button><button onClick={() => void removeDownload(removing).then(() => {
        setRemoving(undefined)
        return client.invalidateQueries({ queryKey: accountQueryKey('downloads') })
      }).catch(e => setError(commandErrorMessage(e)))}>删除副本</button></div>
    </LargeDialog>}
  </>
}
