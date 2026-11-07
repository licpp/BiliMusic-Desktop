import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Link2, Play, Plus, RefreshCw, X } from 'lucide-react'
import {
  changeLinkedVideo, commandErrorMessage, getLinkedFolder, getVideoParts, listPlaylists,
  type FavoriteVideo, type Playlist,
} from '../../services/desktopApi'
import { accountEpoch } from '../../services/accountScope'
import { toTrack } from '../../services/collectionTrack'
import { Artwork } from '../../shared/Artwork'
import { ActionMenu } from '../../shared/ActionMenu'
import { useRowContextMenu } from '../../shared/useRowContextMenu'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { linkedFolderKey, reloadLinkedFolder } from '../../services/linkedFolders'
import { VideoPartsList } from './VideoPartsList'
import { usePlayerStore } from '../player/playerStore'
import { PlaylistMenu } from './PlaylistEntry'

export function LinkedFolderView({ playlist, onUnlink }: { playlist: Playlist & { biliFolderId: number }; onUnlink: () => void }) {
  const { biliFolderId: folderId, name } = playlist
  const client = useQueryClient()
  const folder = useQuery({ queryKey: linkedFolderKey(folderId), queryFn: () => getLinkedFolder(folderId) })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [expanded, setExpanded] = useState<string>()
  const [confirm, setConfirm] = useState<FavoriteVideo>()
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
  const refresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshError('')
    try { await reloadLinkedFolder(client, folderId) }
    catch (cause) { setRefreshError(commandErrorMessage(cause)) }
    finally { setRefreshing(false) }
  }, [client, folderId])
  useEffect(() => {
    if (attempted.current) return
    attempted.current = true
    void refresh()
  }, [refresh])

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
    <header>
      <div><span className="eyebrow">BILIBILI</span>
        <div className="linked-folder-title"><h2>{folder.data?.name || name}</h2>
          <span className="sync-label" role="status" title={folder.data ? new Date(folder.data.refreshedAt * 1000).toLocaleString('zh-CN') : undefined}>
            {refreshing ? '正在同步…' : refreshError ? '同步失败' : folder.data ? '已同步' : '等待同步'}
          </span>
        </div>
        <p>{folder.data?.videos.length ?? playlist.trackCount} 个视频 · 关联 B 站收藏夹</p>
      </div>
    </header>
    <div className="collection-actions">
      <button type="button" className="collection-primary" disabled={busy} onClick={() => setAdding(value => !value)}><Plus size={16}/>添加视频</button>
      <PlaylistMenu playlist={playlist} onRefresh={refresh} onRemoved={onUnlink}/>
    </div>
    {refreshError && <div className="linked-refresh-error" role="alert">
      <span>{folder.data ? '已保留上次同步的内容。' : ''}{refreshError}</span>
      <button type="button" className="collection-flat-button" onClick={() => void refresh()}><RefreshCw size={15}/>重试</button>
    </div>}
    {adding && <form className="playlist-management" onSubmit={event => {
      event.preventDefault()
      if (!busy && bvid.trim()) void run(() => change(bvid.trim(), true))
    }}>
      <input autoFocus value={bvid} onChange={event => setBvid(event.target.value)} aria-label="视频 BV 号" placeholder="输入视频 BV 号" maxLength={32}/>
      <button type="submit" className="collection-flat-button" disabled={busy || !bvid.trim()}>添加到 B 站收藏夹</button>
    </form>}
    {confirm && <CollectionDialog title="从 B 站收藏夹移除" onClose={() => { if (!busy) setConfirm(undefined) }}>
      <p>从 B 站收藏夹移除整个视频「{confirm.title || confirm.bvid}」及其全部分 P？</p>
      {error && <p role="alert" className="inline-error">{error}</p>}
      <footer>
        <button type="button" className="collection-flat-button" disabled={busy} onClick={() => setConfirm(undefined)}>取消</button>
        <button type="button" className="collection-flat-button action-danger" disabled={busy} onClick={() => void run(() => change(confirm.bvid, false))}>确认移除视频</button>
      </footer>
    </CollectionDialog>}
    {error && !confirm && <p role="alert" className="inline-error">{error}</p>}
    {!folder.data && (folder.isLoading || refreshing) && <p className="batch-message">正在读取收藏夹…</p>}
    {folder.error && !refreshError && !refreshing && !folder.data && <p role="alert" className="inline-error">{commandErrorMessage(folder.error)}</p>}
    {folder.data?.videos.length === 0 && <p className="batch-message">这个收藏夹里还没有视频</p>}
    <div className="result-list">{folder.data?.videos.map(video => <LinkedVideoRow key={video.bvid} video={video}
      expanded={expanded === video.bvid} busy={busy} onOpen={() => setExpanded(value => value === video.bvid ? undefined : video.bvid)}
      onRemove={() => { setError(''); setConfirm(video) }}/>)}</div>
  </section>
}

function LinkedVideoRow({ video, expanded, busy, onOpen, onRemove }: {
  video: FavoriteVideo; expanded: boolean; busy: boolean; onOpen: () => void; onRemove: () => void
}) {
  const { position, onContextMenu } = useRowContextMenu()
  const playVideo = async () => {
    const detail = await getVideoParts(video.bvid)
    await usePlayerStore.getState().playAll(detail.parts.map(part => toTrack(detail, part)))
  }
  const [playError, setPlayError] = useState('')
  return <article className="result-card">
    <div className="search-result-heading" onContextMenu={onContextMenu}>
      <button type="button" className="result-main" aria-expanded={expanded} onClick={onOpen}>
        <span className="result-cover" onClick={event => { event.stopPropagation(); void playVideo().catch(error => setPlayError(commandErrorMessage(error))) }}><Artwork src={video.cover}/><i><Play size={17}/></i></span>
        <span className="result-copy"><strong>{video.title || video.bvid}</strong><small>{video.bvid}</small></span>
        {expanded ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}
      </button>
      <ActionMenu sheet label={`操作 ${video.title || video.bvid}`} contextPosition={position}>{close => <>
        <button role="menuitem" onClick={() => { close(); onOpen() }}>{expanded ? '收起分 P' : '展开分 P'}</button>
        <button role="menuitem" disabled={busy} onClick={() => { close(); onRemove() }}>从 B 站收藏夹移除</button>
      </>}</ActionMenu>
    </div>
    {playError && <p role="alert" className="inline-error">{playError}</p>}
    {expanded && <LinkedVideoParts bvid={video.bvid}/>}
  </article>
}

function LinkedVideoParts({ bvid }: { bvid: string }) {
  const detail = useQuery({ queryKey: ['collection-parts', bvid], queryFn: () => getVideoParts(bvid) })
  if (detail.isLoading) return <p className="batch-message">正在加载分 P…</p>
  if (detail.error) return <p role="alert" className="inline-error">{commandErrorMessage(detail.error)}</p>
  const video = detail.data
  if (!video?.parts.length) return <p className="batch-message">暂无可播放内容</p>
  return <VideoPartsList tracks={video.parts.map(part => toTrack(video, part))}/>
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
