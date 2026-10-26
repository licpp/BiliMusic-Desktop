import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { addTrackToPlaylist, commandErrorMessage, createPlaylist, getAccountProfile, getFavoriteFolders, getFavoriteVideos, getVideoParts, saveLibraryTrack, type FavoriteFolder } from '../../services/desktopApi'

export function ImportFavorites({ onClose }: { onClose: () => void }) {
  const client = useQueryClient()
  const account = useQuery({ queryKey: ['account'], queryFn: getAccountProfile })
  const folders = useQuery({ queryKey: ['bili-favorites', account.data?.userId], queryFn: getFavoriteFolders, enabled: Boolean(account.data?.loggedIn) })
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const cancelled = useRef(false)
  useEffect(() => () => { cancelled.current = true }, [])

  const importFolder = async (folder: FavoriteFolder) => {
    cancelled.current = false; setRunning(true); setErrors([])
    let count = 0
    try {
      const playlist = await createPlaylist(folder.title)
      for (let page = 1; !cancelled.current; page++) {
        setStatus(`正在读取第 ${page} 页，已导入 ${count} 首`)
        const result = await getFavoriteVideos(folder.id, page)
        const videos = result.medias || []
        for (const video of videos) {
          if (cancelled.current) break
          setStatus(`正在解析「${video.title}」，已导入 ${count} 首`)
          try {
            const detail = await getVideoParts(video.bvid)
            for (const part of detail.parts) {
              if (cancelled.current) break
              const track = await saveLibraryTrack({ id: `bilibili:${detail.bvid}:${part.cid}`, source: { provider: 'bilibili', bvid: detail.bvid, aid: detail.aid, cid: part.cid, page: part.page, uploaderId: detail.uploaderId, uploaderName: detail.uploaderName }, title: part.title || detail.title, coverUrl: part.coverUrl || detail.coverUrl, durationSeconds: part.durationSeconds, liked: false })
              await addTrackToPlaylist(playlist.id, track.id)
              count++
            }
          } catch (cause) { setErrors((existing) => [...existing, `${video.title}：${commandErrorMessage(cause)}`]) }
        }
        if (!result.has_more || !videos.length) break
      }
      setStatus(`${cancelled.current ? '已停止' : '导入完成'}，已保存 ${count} 首歌曲到「${folder.title}」`)
    } catch (cause) { setStatus(`导入中断，已保存 ${count} 首：${commandErrorMessage(cause)}`) }
    finally { setRunning(false); await client.invalidateQueries({ queryKey: ['playlists'] }); await client.invalidateQueries({ queryKey: ['library'] }) }
  }

  return <div className="dialog-backdrop"><div className="playlist-picker import-favorites" role="dialog" aria-modal="true" aria-label="导入 B 站收藏夹"><header><div><span className="eyebrow">IMPORT</span><h3>导入 B 站收藏夹</h3></div><button onClick={() => { cancelled.current = true; onClose() }} aria-label="关闭"><X /></button></header><p>创建本地歌单，分 P 会拆分为独立歌曲。导入进度会保留，失效视频将跳过。</p>{!account.data?.loggedIn ? <p>请先点击右上角头像，扫码登录 B 站账号。</p> : folders.isLoading ? <p>正在读取收藏夹…</p> : folders.isError ? <button className="load-more" onClick={() => void folders.refetch()}>{commandErrorMessage(folders.error)} · 重试</button> : <div className="import-folder-list">{folders.data?.map((folder) => <button key={folder.id} disabled={running} onClick={() => void importFolder(folder)}><span><strong>{folder.title}</strong><small>{folder.media_count} 个视频</small></span><Download size={17} /></button>)}{folders.data?.length === 0 && <p>还没有收藏夹</p>}</div>}{status && <p className="import-status" role="status">{running && <LoaderCircle size={15} className="spin" />}{status}</p>}{running && <button className="load-more" onClick={() => { cancelled.current = true }}>停止导入</button>}{Boolean(errors.length) && <details><summary>{errors.length} 个视频未能导入</summary>{errors.map((error, index) => <p key={index}>{error}</p>)}</details>}</div></div>
}
