import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Download, LoaderCircle, TriangleAlert } from 'lucide-react'
import { commandErrorMessage, listDownloads } from '../../services/desktopApi'

export function DownloadsView() {
  const downloads = useQuery({ queryKey: ['downloads'], queryFn: listDownloads, refetchInterval: (query) => query.state.data?.some((item) => item.status === 'queued' || item.status === 'downloading') ? 1000 : false })
  return <section className="downloads-view"><header><span className="eyebrow">OFFLINE</span><h2>下载</h2><p>已下载音频保存在你选择的本地目录。</p></header>{downloads.isError ? <div className="download-empty">{commandErrorMessage(downloads.error)}</div> : downloads.data?.length ? <div className="download-list">{downloads.data.map((item) => <article key={item.id}><span className={`download-state ${item.status}`}>{item.status === 'completed' ? <CheckCircle2 /> : item.status === 'failed' ? <TriangleAlert /> : <LoaderCircle className="spin" />}</span><span><strong>{filename(item.targetPath)}</strong><small>{item.errorMessage || item.targetPath}</small></span><span>{formatBytes(item.receivedBytes)}{item.totalBytes ? ` / ${formatBytes(item.totalBytes)}` : ''}</span></article>)}</div> : <div className="download-empty"><Download /><h3>还没有下载</h3><p>在音乐库中点击歌曲右侧的下载按钮。</p></div>}</section>
}
const filename = (path: string) => path.split(/[\\/]/).pop() || path
const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
