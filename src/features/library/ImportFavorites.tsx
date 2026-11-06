import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, LoaderCircle, X } from 'lucide-react'
import { reloadLinkedFolder } from '../../services/linkedFolders'
import { accountEpoch } from '../../services/accountScope'
import { toTrack } from '../../services/collectionTrack'
import { useEffect, useRef, useState } from 'react'
import { addTrackToPlaylist, commandErrorMessage, createPlaylist, getAccountProfile, getFavoriteFolders, getFavoriteVideos, getVideoParts, saveLibraryTrack, type FavoriteFolder } from '../../services/desktopApi'

export function ImportFavorites({ onClose, onImported }: { onClose: () => void; onImported: (id: string, mode: 'copy' | 'link') => void }) {
  const client = useQueryClient()
  const account = useQuery({ queryKey: ['account'], queryFn: getAccountProfile })
  const folders = useQuery({ queryKey: ['bili-favorites', account.data?.userId], queryFn: getFavoriteFolders, enabled: Boolean(account.data?.loggedIn) })
  const [mode, setMode] = useState<'copy' | 'link'>('copy')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [partialId, setPartialId] = useState<string>()
  const [errors, setErrors] = useState<string[]>([])
  const cancelled = useRef(false)
  useEffect(() => () => { cancelled.current = true }, [])

  const importFolder = async (folder: FavoriteFolder) => {
    cancelled.current = false; setRunning(true); setErrors([]); setPartialId(undefined)
    const epoch = accountEpoch()
    const stopped = () => cancelled.current || epoch !== accountEpoch()
    let count = 0
    let failed = 0
    try {
      if (mode === 'link') {
        setStatus('正在读取并关联收藏夹…')
        await reloadLinkedFolder(client, folder.id, true)
        if (!stopped()) onImported(`bili-folder:${folder.id}`, 'link')
        return
      }
      const playlist = await createPlaylist(folder.title)
      setPartialId(playlist.id)
      for (let page = 1; !stopped(); page++) {
        setStatus(`正在读取第 ${page} 页，已导入 ${count} 首`)
        const result = await getFavoriteVideos(folder.id, page)
        const videos = result.medias || []
        for (const video of videos) {
          if (stopped()) break
          if (!video.bvid) continue
          setStatus(`正在解析「${video.title}」，已导入 ${count} 首`)
          try {
            const detail = await getVideoParts(video.bvid)
            for (const part of detail.parts) {
              if (stopped()) break
              const track = await saveLibraryTrack(toTrack(detail, part))
              if (stopped()) break
              await addTrackToPlaylist(playlist.id, track.id)
              count++
            }
          } catch (cause) { failed++; setErrors((existing) => [...existing, `${video.title}：${commandErrorMessage(cause)}`]) }
        }
        if (!result.has_more || !videos.length) break
      }
      if (!stopped() && failed === 0) {
        await client.invalidateQueries({ queryKey: ['playlists'] })
        if (!stopped()) onImported(playlist.id, 'copy')
      }
      setStatus(`${cancelled.current ? '已停止' : '导入完成'}，已保存 ${count} 首歌曲到「${folder.title}」`)
    } catch (cause) { setStatus(mode === 'link' ? `关联失败：${commandErrorMessage(cause)}` : `导入中断，已保存 ${count} 首：${commandErrorMessage(cause)}`) }
    finally { setRunning(false); await client.invalidateQueries({ queryKey: ['playlists'] }); await client.invalidateQueries({ queryKey: ['library'] }) }
  }

  return <div className="dialog-backdrop"><div className="playlist-picker import-favorites" role="dialog" aria-modal="true" aria-label="导入 B 站收藏夹"><header><div><span className="eyebrow">IMPORT</span><h3>导入 B 站收藏夹</h3></div><button className="collection-icon" disabled={running && mode === 'link'} onClick={() => { cancelled.current = true; onClose() }} aria-label="关闭"><X /></button></header><fieldset className="import-mode" disabled={running}><legend>导入方式</legend>
    <label><input type="radio" name="favorite-import-mode" checked={mode === 'copy'} onChange={() => setMode('copy')} /><span><strong>复制为本地歌单</strong><small>复制当前内容，分 P 拆成独立歌曲。</small></span></label>
    <label><input type="radio" name="favorite-import-mode" checked={mode === 'link'} onChange={() => setMode('link')} /><span><strong>关联 B 站收藏夹</strong><small>按视频双向同步。添加和移除会更新 B 站原收藏夹。</small></span></label>
    </fieldset>{!account.data?.loggedIn ? <p>请先点击右上角头像，扫码登录 B 站账号。</p> : folders.isLoading ? <p>正在读取收藏夹…</p> : folders.isError ? <button className="load-more" onClick={() => void folders.refetch()}>{commandErrorMessage(folders.error)} · 重试</button> : <div className="import-folder-list">{folders.data?.map((folder) => <button key={folder.id} disabled={running} onClick={() => void importFolder(folder)}><span><strong>{folder.title}</strong><small>{folder.media_count} 个视频</small></span><Download size={17} /></button>)}{folders.data?.length === 0 && <p>还没有收藏夹</p>}</div>}{status && <p className="import-status" role="status">{running && <LoaderCircle size={15} className="spin" />}{status}</p>}{running && mode === 'copy' && <button className="load-more" onClick={() => { cancelled.current = true }}>停止导入</button>}{!running && partialId && <button type="button" className="collection-flat-button" onClick={() => onImported(partialId, 'copy')}>打开已导入的歌单</button>}{Boolean(errors.length) && <details><summary>{errors.length} 个视频未能导入</summary>{errors.map((error, index) => <p key={index}>{error}</p>)}</details>}</div></div>
}
