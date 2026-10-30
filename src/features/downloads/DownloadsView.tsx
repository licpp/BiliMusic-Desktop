import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Download, LoaderCircle, Play, RotateCcw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { commandErrorMessage, downloadTrack, listDownloads, listLibraryTracks, type DownloadRecord } from '../../services/desktopApi'
import { usePlayerStore } from '../player/playerStore'
import { TrackMenuButton } from '../library/TrackActions'
import { showTrackMenu } from '../library/trackActionStore'

export function DownloadsView() {
  const [error, setError] = useState('')
  const [retrying, setRetrying] = useState<string | null>(null)
  const library = useQuery({ queryKey: ['library'], queryFn: () => listLibraryTracks() })
  const downloads = useQuery({ queryKey: ['downloads'], queryFn: listDownloads, refetchInterval: (query) => query.state.data?.some((item) => item.status === 'queued' || item.status === 'downloading') ? 1000 : false })
  const playableTracks = (downloads.data || []).filter(d=>d.status==='completed').map(d=>library.data?.find(t=>t.id===d.trackId)).filter((t): t is NonNullable<typeof t>=>!!t)
  const act = async (item: DownloadRecord) => {
    const track = library.data?.find((track) => track.id === item.trackId)
    if (!track) { setError('歌曲信息未加载，请稍后重试'); return }
    setRetrying(item.id); setError('')
    try { if (item.status === 'completed') { await usePlayerStore.getState().playFromList(playableTracks,track.id); return }; await downloadTrack(track, item.targetPath.replace(/[\\/][^\\/]+$/, '')); await downloads.refetch() }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setRetrying(null) }
  }
  return <section className="downloads-view"><header><span className="eyebrow">OFFLINE</span><h2>下载</h2><p>播放时优先使用本地音频，断网也能继续聆听。</p></header>{error && <p className="inline-error">{error}</p>}{downloads.isError ? <div className="download-empty">{commandErrorMessage(downloads.error)}</div> : downloads.data?.length ? <div className="download-list">{downloads.data.map((item) => { const track = library.data?.find((track) => track.id === item.trackId); return <article className="download-row" key={item.id} onContextMenu={(event) => { if (track) showTrackMenu(event, track,undefined,playableTracks) }}><span className={`download-state ${item.status}`}>{item.status === 'completed' ? <CheckCircle2 /> : item.status === 'failed' ? <TriangleAlert /> : <LoaderCircle className="spin" />}</span><div className="download-copy"><strong title={track?.title || filename(item.targetPath)}>{track?.title || filename(item.targetPath)}</strong><small title={item.errorMessage || item.targetPath}>{formatBytes(item.receivedBytes)}{item.totalBytes ? ` / ${formatBytes(item.totalBytes)}` : ''} · {item.errorMessage || ({completed:'已下载',failed:'下载失败',queued:'等待下载',downloading:'下载中'}[item.status])}</small>{item.totalBytes && item.status === 'downloading' ? <progress aria-label="下载进度" max={item.totalBytes} value={item.receivedBytes} /> : null}</div><div className="row-actions">{(item.status === 'completed' || item.status === 'failed') && <button className="icon-action" disabled={Boolean(retrying)} aria-label={item.status === 'completed' ? '播放下载的歌曲' : '重新下载'} onClick={() => void act(item)}>{item.status === 'completed' ? <Play size={17} /> : <RotateCcw size={17} />}</button>}{track && <TrackMenuButton track={track} tracks={playableTracks} />}</div></article> })}</div> : <div className="download-empty"><Download /><h3>还没有下载</h3><p>在音乐库中点击歌曲右侧的下载按钮。</p></div>}</section>
}
const filename = (path: string) => path.split(/[\\/]/).pop() || path
const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
