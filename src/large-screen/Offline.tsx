import { accountQueryKey } from '../services/queryKeys'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCw, Trash2 } from 'lucide-react'
import { listDownloads, removeDownload, commandErrorMessage } from '../services/desktopApi'
import { useDownloadBatch } from '../features/downloads/downloadBatch'
import { chooseDownload } from '../features/downloads/downloadRequest'
import { formatDuration } from '../shared/time'
import { Artwork } from '../shared/Artwork'
import { usePlayerStore } from '../features/player/playerStore'
import { Empty, Failure } from './Library'
import { LargeDialog } from './LargeDialog'

export function LargeOffline() {
  const client = useQueryClient(), downloads = useQuery({ queryKey: accountQueryKey('downloads'), queryFn: listDownloads, networkMode: 'always', refetchInterval: 3000 })
  const batch = useDownloadBatch(s => s.batch), busy = useDownloadBatch(s => s.busy)
  const [error, setError] = useState(''), [removing, setRemoving] = useState<string>()
  const complete = [...new Map((downloads.data || []).filter(d => d.status === 'completed' && d.track).map(d => [d.trackId, d.track!])).values()]
  return <><div className="large-section-heading"><h2>离线音乐</h2><span className="large-muted">{complete.length} 首</span></div>{busy && batch && <p className="large-muted" role="status">正在下载 {batch.completed + batch.skipped} / {batch.total}</p>}<Failure error={downloads.error || error} retry={() => { setError(''); void downloads.refetch() }}/>{downloads.data?.map(d => { const t = d.track; return <div className="large-offline-row" key={d.id}><button className="large-track-main" disabled={!t || d.status !== 'completed'} onClick={() => { if (t) void usePlayerStore.getState().playFromList(complete, t.id) }}><span className="large-track-art"><Artwork adaptAspect src={t?.coverUrl}/></span><span><strong>{t?.displayTitle || t?.title || '音乐文件'}</strong><small>{d.status === 'completed' ? t ? formatDuration(t.durationSeconds) : '已下载' : d.status === 'failed' ? d.errorMessage || '下载失败' : d.status === 'queued' ? '等待下载' : `${Math.round(d.receivedBytes / Math.max(1, d.totalBytes || d.receivedBytes) * 100)}%`}</small></span></button>{d.status === 'failed' && t && <button aria-label={`重新下载${t.title}`} disabled={busy} onClick={() => chooseDownload([t])}><RotateCw/></button>}<button disabled={d.status === 'downloading' || d.status === 'queued'} className="large-icon" aria-label={`删除${t?.title || '下载文件'}`} onClick={() => setRemoving(d.id)}><Trash2/></button></div> })}{!downloads.isPending && !downloads.data?.length && <Empty>歌曲的更多菜单中可以下载音乐</Empty>}{removing && <LargeDialog title="删除离线副本？" onClose={() => setRemoving(undefined)}><p>音乐库中的歌曲会保留。</p><div className="large-options"><button onClick={() => setRemoving(undefined)}>取消</button><button onClick={() => void removeDownload(removing).then(() => { setRemoving(undefined); return client.invalidateQueries({ queryKey: accountQueryKey('downloads') }) }).catch(e => setError(commandErrorMessage(e)))}>删除副本</button></div></LargeDialog>}</>
}
