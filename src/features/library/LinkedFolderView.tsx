import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Link2, Play, Plus, RefreshCw, X } from 'lucide-react'
import {
  changeLinkedVideo, commandErrorMessage, getLinkedFolder, getVideoParts, listPlaylists,
  refreshLinkedFolder, unlinkBiliFolder, type FavoriteVideo, type LinkedFolder,
} from '../../services/desktopApi'
import { accountEpoch } from '../../services/accountScope'
import { toTrack } from '../../services/collectionTrack'
import { Artwork } from '../../shared/Artwork'
import { ActionMenu } from '../../shared/ActionMenu'
import { formatDuration } from '../../shared/time'
import { usePlayerStore } from '../player/playerStore'

export const linkedFolderKey = (folderId: number) => ['linked-bili-folder', folderId]

export async function reloadLinkedFolder(client: ReturnType<typeof useQueryClient>, folderId: number, link = false) {
  const epoch = accountEpoch()
  const folder = await refreshLinkedFolder(folderId, link)
  if (epoch === accountEpoch()) {
    client.setQueryData(linkedFolderKey(folderId), folder)
    await client.invalidateQueries({ queryKey: ['playlists'] })
  }
  return folder
}

export function LinkedFolderView({ folderId, name, onUnlink }: {
  folderId: number; name: string; onUnlink: () => void
}) {
  const client = useQueryClient()
  const folder = useQuery({ queryKey: linkedFolderKey(folderId), queryFn: () => getLinkedFolder(folderId) })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string>()
  const [confirm, setConfirm] = useState<FavoriteVideo | 'unlink'>()
  const [bvid, setBvid] = useState('')
  const [adding, setAdding] = useState(false)
  const attempted = useRef(false)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await action() }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  const refresh = () => reloadLinkedFolder(client, folderId)
  useEffect(() => {
    if (!folder.data || attempted.current) return
    attempted.current = true
    if (Date.now() - folder.data.refreshedAt * 1000 > 60_000) void run(refresh)
  }, [folder.data, folderId, client])

  const change = async (videoId: string, add: boolean) => {
    const epoch = accountEpoch()
    const updated = await changeLinkedVideo(folderId, videoId, add)
    if (epoch !== accountEpoch()) return
    setConfirm(undefined)
    setBvid('')
    setAdding(false)
    client.setQueryData(linkedFolderKey(folderId), updated)
    await client.invalidateQueries({ queryKey: ['playlists'] })
  }

  return <section className="library-view linked-folder">
    <header><div><span className="eyebrow">BILIBILI</span><h2>{folder.data?.name || name}</h2>
      <p>{folder.data?.videos.length ?? 0} 个视频 · 关联 B 站收藏夹</p>
    </div></header>
    <div className="collection-actions">
      <button disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={16}/>{busy ? '正在处理…' : '刷新收藏夹'}</button>
      <button disabled={busy} onClick={() => setAdding(value => !value)}><Plus size={16}/>添加视频</button>
      <ActionMenu sheet label="关联歌单管理">{close => <button role="menuitem" disabled={busy} onClick={() => { close(); setConfirm('unlink') }}>解除关联</button>}</ActionMenu>
    </div>
    {folder.data && <p className="batch-message">上次刷新 {new Date(folder.data.refreshedAt * 1000).toLocaleString('zh-CN')}</p>}
    {adding && <form className="playlist-management" onSubmit={event => {
      event.preventDefault()
      if (!busy && bvid.trim()) void run(() => change(bvid.trim(), true))
    }}>
      <input autoFocus value={bvid} onChange={event => setBvid(event.target.value)} aria-label="视频 BV 号" placeholder="输入视频 BV 号" maxLength={32} />
      <button disabled={busy || !bvid.trim()}>添加到 B 站收藏夹</button>
    </form>}
    {confirm && <div className="collection-actions batch-actions">
      <span>{confirm === 'unlink' ? '解除关联并移除此歌单入口？B 站原收藏夹会保留。' : `从 B 站收藏夹移除整个视频「${confirm.title || confirm.bvid}」及其全部分 P？`}</span>
      <button disabled={busy} onClick={() => void run(async () => {
        if (confirm !== 'unlink') { await change(confirm.bvid, false); return }
        await unlinkBiliFolder(folderId)
        client.setQueryData<LinkedFolder | null>(linkedFolderKey(folderId), null)
        await client.invalidateQueries({ queryKey: ['playlists'] })
        onUnlink()
      })}>{confirm === 'unlink' ? '确认解除' : '确认移除视频'}</button>
      <button disabled={busy} onClick={() => setConfirm(undefined)}>取消</button>
    </div>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {folder.isLoading && <p className="batch-message">正在读取收藏夹…</p>}
    {folder.error && <p role="alert" className="inline-error">{commandErrorMessage(folder.error)}</p>}
    {folder.data?.videos.length === 0 && <p className="batch-message">这个收藏夹里还没有视频</p>}
    <div className="result-list">{folder.data?.videos.map(video => <article className="result-card" key={video.bvid}>
      <div className="search-result-heading">
        <button className="result-main" aria-expanded={expanded === video.bvid} onClick={() => setExpanded(value => value === video.bvid ? undefined : video.bvid)}>
          <span className="result-cover"><Artwork src={video.cover}/></span>
          <span className="result-copy"><strong>{video.title || video.bvid}</strong><small>{video.bvid}</small></span>
          {expanded === video.bvid ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}
        </button>
        <ActionMenu sheet label={`操作 ${video.title || video.bvid}`}>{close => <button role="menuitem" disabled={busy} onClick={() => { close(); setConfirm(video) }}>从 B 站收藏夹移除</button>}</ActionMenu>
      </div>
      {expanded === video.bvid && <LinkedVideoParts bvid={video.bvid} />}
    </article>)}</div>
  </section>
}

function LinkedVideoParts({ bvid }: { bvid: string }) {
  const detail = useQuery({ queryKey: ['collection-parts', bvid], queryFn: () => getVideoParts(bvid) })
  if (detail.isLoading) return <p className="batch-message">正在加载分 P…</p>
  if (detail.error) return <p role="alert" className="inline-error">{commandErrorMessage(detail.error)}</p>
  const video = detail.data
  if (!video?.parts.length) return <p className="batch-message">暂无可播放内容</p>
  const tracks = video.parts.map(part => toTrack(video, part))
  return <div className="parts-list">{tracks.map(track => <div className="part-entry" key={track.id}>
    <button onClick={() => void usePlayerStore.getState().playFromList(tracks, track.id)}>
      <span>P{track.source.page}</span><strong>{track.title}</strong><small>{formatDuration(track.durationSeconds)}</small><Play size={14}/>
    </button>
  </div>)}</div>
}

export function LinkedFolderPicker({ bvid, onClose }: { bvid: string; onClose: () => void }) {
  const client = useQueryClient()
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: listPlaylists })
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState('')
  const folders = playlists.data?.filter(playlist => playlist.biliFolderId) || []
  const add = async (folderId: number) => {
    const epoch = accountEpoch()
    setPending(true)
    setStatus('')
    try {
      const updated = await changeLinkedVideo(folderId, bvid, true)
      if (epoch !== accountEpoch()) return
      setStatus('已添加整个视频到 B 站收藏夹')
      client.setQueryData(linkedFolderKey(folderId), updated)
      await client.invalidateQueries({ queryKey: ['playlists'] })
    } catch (cause) { setStatus(commandErrorMessage(cause)) }
    finally { setPending(false) }
  }
  return <div className="dialog-backdrop"><div className="playlist-picker" role="dialog" aria-modal="true" aria-label="添加到关联收藏夹">
    <header><h3>添加到关联收藏夹</h3><button aria-label="关闭" onClick={onClose}><X size={18}/></button></header>
    <p>将整个视频 {bvid} 收藏到 B 站。</p>
    {folders.map(folder => <button key={folder.id} disabled={pending} onClick={() => void add(folder.biliFolderId!)}>
      <span>{folder.name}</span><Link2 size={16}/>
    </button>)}
    {!playlists.isLoading && !folders.length && <p>请先通过「导入 B 站收藏夹」关联一个收藏夹。</p>}
    {status && <p role="status">{status}</p>}
  </div></div>
}
