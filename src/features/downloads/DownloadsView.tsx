import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Download, LoaderCircle, Play, RotateCcw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { commandErrorMessage, downloadTrack, listDownloads, listLibraryTracks, type DownloadRecord } from '../../services/desktopApi'
import { usePlayerStore } from '../player/playerStore'

export function DownloadsView() {
  const [error, setError] = useState('')
  const [retrying, setRetrying] = useState<string | null>(null)
  const library = useQuery({ queryKey: ['library'], queryFn: () => listLibraryTracks() })
  const downloads = useQuery({ queryKey: ['downloads'], queryFn: listDownloads, refetchInterval: (query) => query.state.data?.some((item) => item.status === 'queued' || item.status === 'downloading') ? 1000 : false })
  const act = async (item: DownloadRecord) => {
    const track = library.data?.find((track) => track.id === item.trackId)
    if (!track) { setError('歌曲信息未加载，请稍后重试'); return }
    if (item.status === 'completed') { await usePlayerStore.getState().play(track); return }
    setRetrying(item.id); setError('')
    try { await downloadTrack(track, item.targetPath.replace(/[\\/][^\\/]+$/, '')); await downloads.refetch() }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setRetrying(null) }
  }
  return <section className="downloads-view"><header><span className="eyebrow">OFFLINE</span><h2>下载</h2><p>播放时优先使用本地音频，断网也能继续聆听。</p></header>{error && <p className="inline-error">{error}</p>}{downloads.isError ? <div className="download-empty">{commandErrorMessage(downloads.error)}</div> : downloads.data?.length ? <div className="download-list">{downloads.data.map((item) => <article key={item.id}><span className={`download-state ${item.status}`}>{item.status === 'completed' ? <CheckCircle2 /> : item.status === 'failed' ? <TriangleAlert /> : <LoaderCircle className="spin" />}</span><span><strong>{library.data?.find((track) => track.id === item.trackId)?.title || filename(item.targetPath)}</strong><small>{item.errorMessage || item.targetPath}</small>{item.totalBytes && item.status === 'downloading' ? <progress max={item.totalBytes} value={item.receivedBytes} /> : null}</span><span>{formatBytes(item.receivedBytes)}{item.totalBytes ? ` / ${formatBytes(item.totalBytes)}` : ''}</span>{(item.status === 'completed' || item.status === 'failed') && <button className="icon-action" disabled={Boolean(retrying)} aria-label={item.status === 'completed' ? '播放下载的歌曲' : '重新下载'} onClick={() => void act(item)}>{item.status === 'completed' ? <Play size={17} /> : <RotateCcw size={17} />}</button>}</article>)}</div> : <div className="download-empty"><Download /><h3>还没有下载</h3><p>在音乐库中点击歌曲右侧的下载按钮。</p></div>}</section>
}
const filename = (path: string) => path.split(/[\\/]/).pop() || path
const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
