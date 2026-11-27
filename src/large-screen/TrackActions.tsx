import { HideAction } from '../shared/VisibilityControls'
import { useVisibilityRules } from '../services/contentVisibility'
import { accountQueryKey } from '../services/queryKeys'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Captions, Download, Heart, Link2, ListMusic, ListPlus, ListVideo, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { Track } from '../domain/track'
import { addTrackToPlaylist, changeLinkedVideo, getVideoParts, listPlaylists, saveLibraryTrack, commandErrorMessage } from '../services/desktopApi'
import { offlineUnavailable, useOfflinePlayback } from '../features/player/offlinePlayback'
import { usePlayerStore } from '../features/player/playerStore'
import { playlistCapabilities } from '../features/library/playlistSelection'
import { useDownloadBatch } from '../features/downloads/downloadBatch'
import { chooseDownload } from '../features/downloads/downloadRequest'
import { downloadSelectionMessage, prepareDownloadSelection } from '../features/downloads/downloadSelection'
import { accountEpoch } from '../services/accountScope'
import { LargeDialog } from './LargeDialog'
import { LargeLyricSearch } from './LyricSearch'
import { MetadataDialog } from '../features/library/MetadataDialog'
import { prepareEditableTrack } from '../features/library/editableTrack'

export type LinkedTrackActions = { openParts: () => void; remove: () => void }

export function DownloadListButton({ tracks, visibilityScope }: { tracks: Track[]; visibilityScope?: string }) {
  const busy = useDownloadBatch(s => s.busy)
  const [preparing, setPreparing] = useState(false), [error, setError] = useState('')
  return <><button disabled={busy || preparing || !tracks.length} aria-label="下载这个列表" onClick={async () => {
    const epoch = accountEpoch(); setPreparing(true); setError('')
    try {
      const result = await prepareDownloadSelection(tracks, visibilityScope)
      if (!result || epoch !== accountEpoch()) return
      chooseDownload(result.tracks)
      setError(downloadSelectionMessage(result.failed, result.tracks.length))
    } catch (e) { if (epoch === accountEpoch()) setError(commandErrorMessage(e)) }
    finally { if (epoch === accountEpoch()) setPreparing(false) }
  }}><Download/>{busy || preparing ? '准备下载…' : '下载'}</button>{error && <p className="large-error" role="alert">{error}</p>}</>
}

export function LargeTrackActions({ track, onClose, onFavorite, queue = false, visibilityScope, replaceVideo, linked }: { replaceVideo?:()=>void; visibilityScope?:string; track: Track; onClose: () => void; onFavorite: (track: Track) => Promise<void>; queue?: boolean; linked?: LinkedTrackActions }) {
  const unavailable = useOfflinePlayback(state => offlineUnavailable(track, state))
  const visibilityRules=useVisibilityRules()
  const [page, setPage] = useState<'menu' | 'playlists'>('menu'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [editor, setEditor] = useState<{track: Track; lyrics: boolean}>()
  const editRequest = useRef(0)
  useEffect(() => () => { ++editRequest.current }, [])
  const client = useQueryClient(), epoch = accountEpoch(), downloading = useDownloadBatch(s => s.busy)
  const playlists = useQuery({ queryKey: accountQueryKey('playlists'), queryFn: listPlaylists, enabled: page === 'playlists' })
  const detail = useQuery({ queryKey: ['video-detail', epoch, track.source.bvid], queryFn: () => getVideoParts(track.source.bvid), enabled: (page === 'playlists' || Boolean(linked) && !unavailable) && !track.partCount, retry: false })
  const capabilities = playlistCapabilities({ items: [track.resolveParts ? { kind: 'video', bvid: track.source.bvid, title: track.title } : { kind: 'track', track }] }, { [track.source.bvid]: track.partCount || detail.data?.parts.length || 0 })
  const run = async (fn: () => Promise<unknown>) => { setError(''); setBusy(true); try { await fn(); if (epoch === accountEpoch()) onClose() } catch (e) { setError(commandErrorMessage(e)) } finally { setBusy(false) } }
  const multipart = (track.partCount ?? detail.data?.parts.length ?? 0) > 1
  const canEdit = !track.resolveParts || Boolean(linked) && !multipart && Boolean(track.partCount || detail.data)
  const linkedExpired = Boolean(linked && track.sourceExpired)
  const edit = async (lyrics: boolean) => {
    const operation = ++editRequest.current
    const current = () => epoch === accountEpoch() && operation === editRequest.current
    setError(''); setBusy(true)
    try {
      const saved = await prepareEditableTrack(track, current)
      if (saved && current()) setEditor({track: saved, lyrics})
    } catch (cause) { if (current()) setError(commandErrorMessage(cause)) }
    finally { if (current()) setBusy(false) }
  }
  if (editor?.lyrics) return <LargeLyricSearch track={editor.track} onClose={onClose}/>
  if (editor) return <MetadataDialog track={editor.track} onClose={onClose} onSaved={saved => {
    usePlayerStore.getState().updateTrack(saved)
    for (const key of ['library', 'home-recent', 'playlists']) void client.invalidateQueries({queryKey: accountQueryKey(key)})
    onClose()
  }} renderDialog={body => <LargeDialog title="编辑歌曲信息" className="large-metadata-editor" onClose={onClose}>{body}</LargeDialog>}/>
  return <LargeDialog title={page === 'menu' ? track.displayTitle || track.title : '收藏到歌单'} onClose={onClose}><div className="large-action-list">{page === 'menu' ? <>
    {!track.resolveParts && <button disabled={busy} onClick={() => void run(() => onFavorite(track))}><Heart/>{track.liked ? '取消喜欢' : '喜欢'}</button>}
    <button disabled={busy || unavailable || linkedExpired} onClick={() => { usePlayerStore.getState().enqueue([track]); onClose() }}><ListMusic/>加入播放队列</button>
    {linked && (multipart || !detail.data && !track.partCount) && <button disabled={busy || unavailable} onClick={() => { onClose(); linked.openParts() }}><ListVideo/>查看分 P</button>}
    {replaceVideo&&<button disabled={busy} onClick={()=>{onClose();replaceVideo()}}><RefreshCw/>更换视频</button>}
    {visibilityScope && <HideAction track={track} scope={visibilityScope} rules={visibilityRules} onDone={onClose}/>}
    <button disabled={busy} onClick={() => setPage('playlists')}><ListPlus/>收藏到歌单</button>
    <button disabled={busy || downloading || linkedExpired} onClick={() => void run(async () => {
      const result = await prepareDownloadSelection([track], visibilityScope)
      if (!result || epoch !== accountEpoch()) return
      if (!result.tracks.length) throw Error(downloadSelectionMessage(result.failed, 0))
      chooseDownload(result.tracks)
    })}><Download/>{downloading ? '正在下载…' : '下载歌曲'}</button>
    {canEdit && <>
      <button disabled={busy || Boolean(linked) && unavailable} onClick={() => void edit(false)}><Pencil/>编辑歌曲信息</button>
      <button disabled={busy || Boolean(linked) && unavailable} onClick={() => void edit(true)}><Captions/>匹配或更换歌词</button>
    </>}
    {linked && <button className="action-danger" disabled={busy} onClick={() => { onClose(); linked.remove() }}><Trash2/>从 B 站收藏夹移除</button>}
    {queue && <button disabled={busy} onClick={() => { usePlayerStore.getState().removeFromQueue(track.id); onClose() }}><Trash2/>移出队列</button>}
  </> : <>{playlists.data?.filter(p => p.biliFolderId ? capabilities.linked : capabilities.local).map(p => <button key={p.id} disabled={busy} onClick={() => void run(async () => { const saved = await saveLibraryTrack(track); if (epoch !== accountEpoch()) return; if (p.biliFolderId) await changeLinkedVideo(p.biliFolderId, track.source.bvid, true); else await addTrackToPlaylist(p.id, saved.id); await client.invalidateQueries({ queryKey: accountQueryKey('playlists') }); await client.invalidateQueries({ queryKey: accountQueryKey('library') }) })}>{p.biliFolderId ? <Link2/> : <ListMusic/>}{p.name}</button>)}{playlists.isPending && <p role="status">正在读取歌单…</p>}{(playlists.error || detail.error) && <p role="alert">{commandErrorMessage(playlists.error || detail.error)}</p>}<button onClick={() => setPage('menu')}>返回歌曲操作</button></>}{error && <p className="large-error" role="alert">{error}</p>}</div></LargeDialog>
}
