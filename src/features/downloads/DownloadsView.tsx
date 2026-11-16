import { accountQueryKey } from '../../services/queryKeys'
import { chooseDownload } from './downloadRequest'
import { invoke } from '@tauri-apps/api/core'
import { isIOS, isAndroid } from '../../services/platform'
import { useDownloadBatch } from './downloadBatch'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Download, FolderOutput, LoaderCircle, Play, RotateCcw, Share, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { commandErrorMessage, listDownloads, removeDownload } from '../../services/desktopApi'
import type { DownloadRecord } from '../../domain/downloads'
import { usePlayerStore } from '../player/playerStore'
import { TrackMenuButton } from '../library/TrackMenuButton'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { showTrackMenu } from '../library/trackActionStore'

export function DownloadsView() {
  const { batch, busy } = useDownloadBatch()
  const [error, setError] = useState('')
  const [pendingRemoval, setPendingRemoval] = useState<{ item: DownloadRecord; title: string }>()
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [retrying, setRetrying] = useState<string | null>(null)
  const downloads = useQuery({ queryKey: accountQueryKey('downloads'), queryFn: listDownloads, refetchInterval: (query) => busy || query.state.data?.some((item) => item.status === 'queued' || item.status === 'downloading') ? 1000 : false })
  const playableTracks = (downloads.data || []).filter(d=>d.status==='completed').map(d=>d.track).filter((t): t is NonNullable<typeof t>=>!!t)
  const act = async (item: DownloadRecord) => {
    const track = item.track
    if (!track) { setError('歌曲信息未加载，请稍后重试'); return }
    setRetrying(item.id); setError('')
    try { if (item.status === 'completed') { await usePlayerStore.getState().playFromList(playableTracks,track.id); return }; chooseDownload([track], item.targetPath.replace(/[\\/][^\\/]+$/, '')) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setRetrying(null) }
  }
  const remove = async () => {
    if (!pendingRemoval || removing) return
    setRemoving(true); setRemoveError('')
    try {
      await removeDownload(pendingRemoval.item.id)
      await downloads.refetch()
      setPendingRemoval(undefined)
    } catch (cause) { setRemoveError(commandErrorMessage(cause)) }
    finally { setRemoving(false) }
  }
  return <section className="downloads-view library-tab-content"><header><span className="eyebrow">OFFLINE</span><h2>下载</h2><p>下载前可单独选择音质与格式，下载后可离线聆听。</p></header>{batch && <div className="batch-message" role="status">
    {busy ? '批量下载中' : '批量下载完成'} · 成功 {batch.completed} / {batch.total} · 跳过 {batch.skipped} · 失败 {batch.failures.length}
    {!!batch.failures.length && <details><summary>查看失败原因</summary>{batch.failures.map((failure, index) => <p key={index}>{failure}</p>)}</details>}
  </div>}{notice && <p className="batch-message" role="status">{notice}</p>}{error && <p className="inline-error">{error}</p>}{downloads.isError ? <div className="download-empty">{commandErrorMessage(downloads.error)}</div> : downloads.data?.length ? <div className="download-list">{downloads.data.map((item) => { const track = item.track; return <article className="download-row" key={item.id} onContextMenu={(event) => { if (track) showTrackMenu(event, track,undefined,playableTracks) }}><span className={`download-state ${item.status}`}>{item.status === 'completed' ? <CheckCircle2 /> : item.status === 'failed' ? <TriangleAlert /> : <LoaderCircle className="spin" />}</span><div className="download-copy"><strong title={track?.title || filename(item.targetPath)}>{track?.title || filename(item.targetPath)}</strong><small title={item.status === 'failed' ? commandErrorMessage(item.errorMessage, '下载失败，请重试') : item.targetPath}>{downloadFormat(item.targetPath)} · {formatBytes(item.receivedBytes)}{item.totalBytes ? ` / ${formatBytes(item.totalBytes)}` : ''} · {(item.errorMessage && commandErrorMessage(item.errorMessage, '下载失败，请重试')) || ({completed:'已下载',failed:'下载失败',queued:'等待下载',downloading:'下载中'}[item.status])}</small>{item.totalBytes && item.status === 'downloading' ? <progress aria-label="下载进度" max={item.totalBytes} value={item.receivedBytes} /> : null}</div><div className="row-actions">{(item.status === 'completed' || item.status === 'failed') && <button className="icon-action" disabled={Boolean(retrying)} aria-label={item.status === 'completed' ? '播放下载的歌曲' : '重新下载'} onClick={() => void act(item)}>{item.status === 'completed' ? <Play size={17} /> : <RotateCcw size={17} />}</button>}{(isIOS || isAndroid) && item.status === 'completed' && <button className="icon-action" disabled={exporting} aria-label={isAndroid ? "导出到下载目录" : "分享或导出歌曲"} onClick={() => { setError(''); setNotice(''); setExporting(true); void invoke('mobile_export_download', { downloadId: item.id }).then(() => { if (isAndroid) setNotice('已保存到下载目录，可在系统文件管理器中查看') }).catch(cause => setError(commandErrorMessage(cause))).finally(() => setExporting(false)) }}>{isAndroid ? <FolderOutput size={17}/> : <Share size={17}/>}</button>}{(item.status === 'completed' || item.status === 'failed') && <button type="button" className="icon-action" aria-label="删除下载" title="删除下载" disabled={Boolean(retrying) || removing} onClick={() => { setRemoveError(''); setPendingRemoval({ item, title: track?.title || filename(item.targetPath) }) }}><Trash2 size={17}/></button>}{track && <TrackMenuButton track={track} tracks={playableTracks} />}</div></article> })}</div> : <div className="download-empty"><Download /><h3>还没有下载</h3><p>在音乐库中点击歌曲右侧的下载按钮。</p></div>}
    {pendingRemoval && <CollectionDialog title="删除下载" onClose={() => { if (!removing) setPendingRemoval(undefined) }}>
      <p>{pendingRemoval.title}</p>
      <p>{pendingRemoval.item.status === 'completed' ? isAndroid ? '删除应用内的离线副本。系统文件夹中的音乐文件仍保留，可在文件管理器中删除。' : '删除本机下载文件，歌曲仍保留在原歌单和收藏中。' : '移除此条下载失败的记录。'}</p>
      {removeError && <p role="alert" className="inline-error">{removeError}</p>}
      <footer><button type="button" className="collection-flat-button" disabled={removing} onClick={() => setPendingRemoval(undefined)}>取消</button>
        <button type="button" className="collection-primary" disabled={removing} onClick={() => void remove()}>{removing ? '正在删除…' : '删除'}</button></footer>
    </CollectionDialog>}
  </section>
}
const filename = (path: string) => path.split(/[\\/]/).pop() || path
const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const downloadFormat = (path:string) => ({m4a:'M4A',flac:'FLAC',aac:'AAC',mp3:'MP3',wav:'WAV'}[path.split('.').pop()?.toLowerCase() || ''] || '音频')
