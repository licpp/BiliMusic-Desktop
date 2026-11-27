import { useListRows } from '../../shared/useListRows'
import { useListDataDuringNavigation, useListReveal } from '../../shared/useListMotion'
import { ListSkeleton } from '../../shared/ListSkeleton'
import { accountQueryKey } from '../../services/queryKeys'
import { DiagnosticsViewer } from '../settings/DiagnosticsSettings'
import { chooseDownload } from './downloadRequest'
import { invoke } from '@tauri-apps/api/core'
import { isIOS, isAndroid } from '../../services/platform'
import { useDownloadBatch } from './downloadBatch'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Download, FolderOutput, LoaderCircle, Play, RotateCcw, Share, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { commandErrorMessage, listDownloads } from '../../services/desktopApi'
import type { DownloadRecord } from '../../domain/downloads'
import { usePlayerStore } from '../player/playerStore'
import { TrackMenuButton } from '../library/TrackMenuButton'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { showTrackMenu } from '../library/trackActionStore'
import {
  canRemoveDownload, canRetryDownload, DownloadRemovalDetails, DownloadSelectButton, DownloadSelectionControls,
  downloadTitle, useDownloadRemoval,
} from './DownloadRemoval'

const statusName: Record<DownloadRecord['status'], string> = {
  completed: '已下载', failed: '下载失败', missing: '文件已丢失', queued: '等待下载', downloading: '下载中',
}

export function DownloadsView({ active = true }: { active?: boolean } = {}) {
  const { batch, busy } = useDownloadBatch()
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [diagnostics, setDiagnostics] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const downloads = useQuery({
    queryKey: accountQueryKey('downloads'), queryFn: listDownloads, networkMode: 'always',
    refetchOnMount: 'always', refetchOnWindowFocus: active ? 'always' : false,
    refetchInterval: query => busy || query.state.data?.some(item => item.status === 'queued' || item.status === 'downloading') ? 1000 : false,
  })
  const wasActive = useRef(active)
  const refetchDownloads = downloads.refetch
  useEffect(() => {
    const opened = active && !wasActive.current
    wasActive.current = active
    if (opened) void refetchDownloads({ cancelRefetch: false })
  }, [active, refetchDownloads])
  const rows = useListDataDuringNavigation(downloads.data, 'downloads')
  const removal = useDownloadRemoval(downloads.data || [])
  const loading = downloads.isLoading || Boolean(downloads.data && !rows)
  const list = useRef<HTMLDivElement>(null)
  const rendered = useListRows(rows || [], 'downloads', { active, manualFallback: true })
  useListReveal(list, loading, Boolean(rows?.length), active)
  const playableTracks = useMemo(() => (rows || []).flatMap(row => row.status === 'completed' && row.track ? [row.track] : []), [rows])
  const act = async (item: DownloadRecord) => {
    const track = item.track
    if (!track) { setError('歌曲信息未加载，请稍后重试'); return }
    setRetrying(item.id)
    setError('')
    try {
      if (item.status === 'completed') await usePlayerStore.getState().playFromList(playableTracks, track.id)
      else chooseDownload([track], item.status === 'missing' ? undefined : item.targetPath.replace(/[\\/][^\\/]+$/, ''))
    } catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setRetrying(null) }
  }
  const exportFile = (item: DownloadRecord) => {
    setError('')
    setNotice('')
    setExporting(true)
    void invoke('mobile_export_download', { downloadId: item.id })
      .then(() => { if (isAndroid) setNotice('已保存到下载目录，可在系统文件管理器中查看') })
      .catch(cause => setError(commandErrorMessage(cause)))
      .finally(() => setExporting(false))
  }
  return <section className="downloads-view library-tab-content">
    <header>
      <span className="eyebrow">OFFLINE</span>
      <h2>下载</h2>
      <p>下载前可单独选择音质与格式，下载后可离线聆听。</p>
    </header>
    <DownloadSelectionControls removal={removal}/>
    {batch && <div className="batch-message" role="status">
      {busy ? '批量下载中' : '批量下载完成'} · 成功 {batch.completed} / {batch.total} · 跳过 {batch.skipped} · 失败 {batch.failures.length}
      {!!batch.failures.length && <details><summary>查看失败原因</summary>
        {batch.failures.map((failure, index) => <p key={index}>{failure}</p>)}
        <button type="button" className="collection-flat-button" onClick={() => setDiagnostics(true)}>下载诊断</button>
      </details>}
    </div>}
    {notice && <p className="batch-message" role="status">{notice}</p>}
    {error && <p className="inline-error">{error}</p>}
    {downloads.isError ? <div className="download-empty">{commandErrorMessage(downloads.error)}</div>
      : loading ? <ListSkeleton label="正在读取下载"/>
      : rows?.length ? <div className="download-list" ref={list}>
        {rendered.rows.map(item => {
          const track = item.track
          const title = downloadTitle(item)
          const completed = item.status === 'completed'
          const canRemove = canRemoveDownload(item)
          const retryable = canRetryDownload(item)
          const status = retryable ? commandErrorMessage(item.errorMessage, statusName[item.status]) : statusName[item.status]
          const detail = downloadFormat(item.targetPath) + ' · ' + formatBytes(item.receivedBytes)
            + (item.totalBytes ? ' / ' + formatBytes(item.totalBytes) : '')
          const selecting = removal.selecting && canRemove
          return <article className="download-row" key={item.id} data-download-selected={selecting && removal.ids.has(item.id) || undefined}
            onClick={selecting ? () => removal.toggle(item.id) : undefined}
            onContextMenu={removal.selecting ? undefined : event => { if (track) showTrackMenu(event, track, undefined, playableTracks) }}>
            <span className={'download-state ' + item.status}>{completed ? <CheckCircle2/> : retryable ? <TriangleAlert/> : <LoaderCircle className="spin"/>}</span>
            <div className="download-copy">
              <strong title={title}>{title}</strong>
              <small title={retryable ? status : item.targetPath}>{retryable ? status + ' · ' + detail : detail + ' · ' + status}</small>
              {item.totalBytes && item.status === 'downloading' ? <progress aria-label="下载进度" max={item.totalBytes} value={item.receivedBytes}/> : null}
            </div>
            <div className="row-actions">{removal.selecting ? canRemove && <DownloadSelectButton record={item} removal={removal}/> : <>
              {canRemove && <button type="button" className="icon-action" disabled={Boolean(retrying)} aria-label={completed ? '播放下载的歌曲' : '重新下载'} onClick={() => void act(item)}>
                {completed ? <Play size={17}/> : <RotateCcw size={17}/>}
              </button>}
              {(isIOS || isAndroid) && completed && <button type="button" className="icon-action" disabled={exporting} aria-label={isAndroid ? '导出到下载目录' : '分享或导出歌曲'} onClick={() => exportFile(item)}>
                {isAndroid ? <FolderOutput size={17}/> : <Share size={17}/>}
              </button>}
              {canRemove && <button type="button" className="icon-action" aria-label="删除下载" title="删除下载" disabled={Boolean(retrying) || removal.removing} onClick={() => removal.request([item])}><Trash2 size={17}/></button>}
              {track && <TrackMenuButton track={track} tracks={playableTracks}/>}
            </>}</div>
          </article>
        })}
        {rendered.manualMore ? <div ref={rendered.tail}><button type="button" className="collection-flat-button" onClick={rendered.manualMore}>加载更多</button></div>
          : rendered.more && <div ref={rendered.tail} className="list-render-tail" aria-hidden="true"/>}
      </div> : <div className="download-empty"><Download/><h3>还没有下载</h3><p>在音乐库中点击歌曲右侧的下载按钮。</p></div>}
    {diagnostics && <DiagnosticsViewer initialArea="download" onClose={() => setDiagnostics(false)}/>}
    {removal.pending && <CollectionDialog title="删除下载" onClose={removal.cancel} className="download-removal-dialog">
      <DownloadRemovalDetails removal={removal} keepsExportedFiles={isAndroid}/>
      <footer>
        <button type="button" className="collection-flat-button" disabled={removal.removing} onClick={removal.cancel}>取消</button>
        <button type="button" className="collection-primary" disabled={removal.removing} onClick={() => void removal.confirm()}>{removal.removing ? '正在删除…' : '删除'}</button>
      </footer>
    </CollectionDialog>}
  </section>
}
const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? (bytes / 1024).toFixed(0) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB'

const downloadFormat = (path: string) => ({m4a:'M4A',flac:'FLAC',aac:'AAC',mp3:'MP3',wav:'WAV'}[path.split('.').pop()?.toLowerCase() || ''] || '音频')
