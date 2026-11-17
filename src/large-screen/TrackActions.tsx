import { HideAction } from '../shared/VisibilityControls'
import { useVisibilityRules } from '../services/contentVisibility'
import { accountQueryKey } from '../services/queryKeys'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Heart, Link2, ListMusic, ListPlus, RefreshCw, Trash2 } from 'lucide-react'
import type { Track } from '../domain/track'
import { addTrackToPlaylist, changeLinkedVideo, getVideoParts, listPlaylists, saveLibraryTrack, commandErrorMessage } from '../services/desktopApi'
import { usePlayerStore } from '../features/player/playerStore'
import { playlistCapabilities } from '../features/library/playlistSelection'
import { useDownloadBatch } from '../features/downloads/downloadBatch'
import { chooseDownload } from '../features/downloads/downloadRequest'
import { accountEpoch } from '../services/accountScope'
import { LargeDialog } from './LargeDialog'
import { toTrack } from '../services/collectionTrack'

export function DownloadListButton({ tracks }: { tracks: Track[] }) {
  const busy = useDownloadBatch(s => s.busy)
  const [preparing, setPreparing] = useState(false), [error, setError] = useState('')
  return <><button disabled={busy || preparing || !tracks.length} aria-label="下载这个列表" onClick={async () => {
    const epoch = accountEpoch(); setPreparing(true); setError('')
    try {
      const expanded = await expandDownloads(tracks, epoch)
      if (epoch === accountEpoch()) chooseDownload(expanded)
    } catch (e) { setError(commandErrorMessage(e)) } finally { setPreparing(false) }
  }}><Download/>{busy || preparing ? '准备下载…' : '下载'}</button>{error && <p className="large-error" role="alert">{error}</p>}</>
}

export function LargeTrackActions({ track, onClose, onFavorite, queue = false, visibilityScope, replaceVideo }: { replaceVideo?:()=>void; visibilityScope?:string; track: Track; onClose: () => void; onFavorite: (track: Track) => Promise<void>; queue?: boolean }) {
  const visibilityRules=useVisibilityRules()
  const [page, setPage] = useState<'menu' | 'playlists'>('menu'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const client = useQueryClient(), epoch = accountEpoch(), downloading = useDownloadBatch(s => s.busy)
  const playlists = useQuery({ queryKey: accountQueryKey('playlists'), queryFn: listPlaylists, enabled: page === 'playlists' })
  const detail = useQuery({ queryKey: ['video-detail', epoch, track.source.bvid], queryFn: () => getVideoParts(track.source.bvid), enabled: page === 'playlists' && !track.partCount })
  const capabilities = playlistCapabilities({ items: [track.resolveParts ? { kind: 'video', bvid: track.source.bvid, title: track.title } : { kind: 'track', track }] }, { [track.source.bvid]: track.partCount || detail.data?.parts.length || 0 })
  const run = async (fn: () => Promise<unknown>) => { setError(''); setBusy(true); try { await fn(); if (epoch === accountEpoch()) onClose() } catch (e) { setError(commandErrorMessage(e)) } finally { setBusy(false) } }
  return <LargeDialog title={page === 'menu' ? track.displayTitle || track.title : '收藏到歌单'} onClose={onClose}><div className="large-action-list">{page === 'menu' ? <>
    {!track.resolveParts && <button disabled={busy} onClick={() => void run(() => onFavorite(track))}><Heart/>{track.liked ? '取消喜欢' : '喜欢'}</button>}
    <button disabled={busy} onClick={() => { usePlayerStore.getState().enqueue([track]); onClose() }}><ListMusic/>加入播放队列</button>
    {replaceVideo&&<button disabled={busy} onClick={()=>{onClose();replaceVideo()}}><RefreshCw/>更换视频</button>}
    {visibilityScope && <HideAction track={track} scope={visibilityScope} rules={visibilityRules} onDone={onClose}/>}
    <button disabled={busy} onClick={() => setPage('playlists')}><ListPlus/>收藏到歌单</button>
    <button disabled={busy || downloading} onClick={() => void run(async () => { const expanded = await expandDownloads([track], epoch); if (epoch !== accountEpoch()) return; chooseDownload(expanded) })}><Download/>{downloading ? '正在下载…' : '下载歌曲'}</button>
    {queue && <button disabled={busy} onClick={() => { usePlayerStore.getState().removeFromQueue(track.id); onClose() }}><Trash2/>移出队列</button>}
  </> : <>{playlists.data?.filter(p => p.biliFolderId ? capabilities.linked : capabilities.local).map(p => <button key={p.id} disabled={busy} onClick={() => void run(async () => { const saved = await saveLibraryTrack(track); if (epoch !== accountEpoch()) return; if (p.biliFolderId) await changeLinkedVideo(p.biliFolderId, track.source.bvid, true); else await addTrackToPlaylist(p.id, saved.id); await client.invalidateQueries({ queryKey: accountQueryKey('playlists') }); await client.invalidateQueries({ queryKey: accountQueryKey('library') }) })}>{p.biliFolderId ? <Link2/> : <ListMusic/>}{p.name}</button>)}{playlists.isPending && <p role="status">正在读取歌单…</p>}{(playlists.error || detail.error) && <p role="alert">{commandErrorMessage(playlists.error || detail.error)}</p>}<button onClick={() => setPage('menu')}>返回歌曲操作</button></>}{error && <p className="large-error" role="alert">{error}</p>}</div></LargeDialog>
}

async function expandDownloads(tracks: Track[], epoch: number) {
  const result: Track[] = []
  for (const track of tracks) {
    if (epoch !== accountEpoch()) throw Error('账号已切换')
    if (track.resolveParts) { const detail = await getVideoParts(track.source.bvid); result.push(...detail.parts.map(p => toTrack(detail, p))) }
    else result.push(track)
  }
  return result
}
