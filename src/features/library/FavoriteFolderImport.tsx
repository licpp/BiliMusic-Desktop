import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, FolderHeart, Link2, ListPlus, LoaderCircle, Square } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { importFavoriteFolders, type FolderImportResult } from '../../services/biliFavoriteImport'
import { commandErrorMessage, getAccountProfile, getFavoriteFolders, getFavoriteVideos, getVideoParts } from '../../services/desktopApi'
import { reloadLinkedFolder } from '../../services/linkedFolders'
import { bootPlaylistImport, commitImportTracks, usePlaylistImport } from '../../services/playlistImport'
import { accountKeyAt } from '../../services/queryKeys'

export type FavoriteFolderImportMode = 'copy' | 'link'

export function FavoriteFolderImport({ busy, onBusyChange, onStop, onImported, onLogin, active = true }: {
  busy: boolean
  onBusyChange: (busy: boolean) => void
  onStop: () => void
  onImported: (id: string, mode: FavoriteFolderImportMode) => void
  onLogin?: () => void
  active?: boolean
}) {
  const client = useQueryClient()
  const epoch = accountEpoch()
  const account = useQuery({ queryKey: accountKeyAt(epoch, 'account'), queryFn: getAccountProfile, enabled: active })
  const folders = useQuery({
    queryKey: accountKeyAt(epoch, 'bili-favorites', account.data?.userId),
    queryFn: getFavoriteFolders,
    enabled: active && Boolean(account.data?.loggedIn),
  })
  const [mode, setMode] = useState<FavoriteFolderImportMode>('link')
  const [selected, setSelected] = useState(new Set<number>())
  const [results, setResults] = useState<FolderImportResult[]>([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [partialId, setPartialId] = useState('')
  const copyIds = useRef(new Map<number, string>())
  const alive = useRef(false)
  const saving = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const rows = folders.data || []
  const allSelected = rows.length > 0 && rows.every(folder => selected.has(folder.id))
  const run = async () => {
    const chosen = rows.filter(folder => selected.has(folder.id))
    if (saving.current || !chosen.length || epoch !== accountEpoch()) return
    const stopped = () => !alive.current || epoch !== accountEpoch()
    saving.current = true
    onBusyChange(true)
    setError('')
    setStatus('正在准备导入…')
    setResults([])
    try {
      await bootPlaylistImport()
      if (stopped()) return
      const scope = usePlaylistImport.getState().scope
      if (!scope) throw new Error('导入准备失败，请重试')
      const outcome = await importFavoriteFolders({
        folders: chosen, mode, scope, copyIds: copyIds.current, stopped,
        progress: text => { if (!stopped()) setStatus(text) },
        result: result => {
          if (stopped()) return
          setResults(items => [...items, result])
          if (mode === 'copy' && result.id) setPartialId(result.id)
        },
        link: id => reloadLinkedFolder(client, id, true),
        videos: getFavoriteVideos,
        detail: bvid => getVideoParts(bvid, false, { background: true, resume: true }),
        save: commitImportTracks,
      })
      if (stopped()) return
      const completed = new Set(outcome.filter(result => !result.error).map(result => result.folderId))
      const pending = chosen.filter(folder => !completed.has(folder.id))
      setSelected(new Set(pending.map(folder => folder.id)))
      setStatus(`已完成 ${completed.size} 个收藏夹${pending.length ? `，${pending.length} 个待重试` : ''}`)
      if (mode === 'link' && chosen.length === 1 && !pending.length && outcome[0]?.id) {
        onImported(outcome[0].id, 'link')
      }
    } catch (cause) {
      if (!stopped()) setError(commandErrorMessage(cause))
    } finally {
      saving.current = false
      if (!stopped()) onBusyChange(false)
      if (epoch === accountEpoch()) {
        void Promise.all(['playlists', 'library'].map(key => client.invalidateQueries({ queryKey: accountKeyAt(epoch, key) })))
      }
    }
  }

  return <>
    <div className="import-body">
      {account.isPending ? <p className="import-inline-status" role="status">正在检查登录状态…</p>
        : account.isError ? <button type="button" className="import-secondary" onClick={() => void account.refetch()}>登录状态读取失败，重试</button>
        : !account.data?.loggedIn ? <div className="import-empty"><FolderHeart size={28}/><p>请先登录 B 站账号，再选择收藏夹。</p>{onLogin && <button type="button" className="import-secondary" onClick={onLogin}>前往设置</button>}</div>
        : <>
          <div className="bili-copy-setting">
            <div><strong id="bili-copy-label">复制为本地歌单</strong><small>{mode === 'copy' ? '复制到「歌单」，之后独立管理。' : '保存到「歌单」，与 B 站保持同步。'}</small></div>
            <button className="bili-copy-switch" type="button" role="switch" aria-labelledby="bili-copy-label" aria-checked={mode === 'copy'} disabled={busy}
              onClick={() => { setMode(mode === 'copy' ? 'link' : 'copy'); setResults([]); setStatus(''); setError(''); setPartialId('') }}><span/></button>
          </div>
          {rows.length > 0 && <div className="import-folder-toolbar"><span>选择收藏夹</span><button type="button" disabled={busy}
            onClick={() => setSelected(new Set(allSelected ? [] : rows.map(folder => folder.id)))}>{allSelected ? '取消全选' : '全选'}</button></div>}
          {folders.isPending ? <p className="import-inline-status" role="status">正在读取收藏夹…</p>
            : folders.isError ? <div><p className="import-error" role="alert">{commandErrorMessage(folders.error)}</p>
              <button type="button" className="import-secondary" onClick={() => void folders.refetch()}>重试</button></div>
            : <div className="import-folders">
              {rows.map(folder => {
                const result = results.find(item => item.folderId === folder.id)
                const checked = selected.has(folder.id)
                return <button type="button" disabled={busy} key={folder.id} aria-pressed={checked} onClick={() => setSelected(previous => {
                  const next = new Set(previous)
                  if (next.has(folder.id)) next.delete(folder.id)
                  else next.add(folder.id)
                  return next
                })}>
                  <span className="import-folder-icon"><FolderHeart size={21}/></span>
                  <span><strong>{folder.title}</strong><small>{folder.media_count} 个视频</small>
                    {result && <span className={result.error ? 'import-folder-error' : 'import-folder-done'}>{result.error || '已完成'}</span>}</span>
                  <span className="import-selection" aria-hidden="true">{checked && <Check size={15}/>}</span>
                </button>
              })}
              {!rows.length && <p className="import-hint">还没有可导入的收藏夹。</p>}
            </div>}
        </>}
      {status && <p className="import-inline-status" role="status">{status}</p>}
      {error && <p className="import-error" role="alert">{error}</p>}
    </div>
    <footer className="import-footer">
      <small>{selected.size ? `已选 ${selected.size} 个收藏夹` : '导入到歌单'}</small>
      {busy && <button type="button" className="import-secondary" onClick={onStop}><Square size={14}/>结束导入</button>}
      {partialId && !busy && <button type="button" className="import-secondary" onClick={() => onImported(partialId, 'copy')}>打开歌单<ArrowRight size={16}/></button>}
      <button type="button" className="import-primary" disabled={busy || !account.data?.loggedIn || !selected.size} onClick={() => void run()}>
        {busy ? <LoaderCircle size={17} className="spin"/> : mode === 'copy' ? <ListPlus size={17}/> : <Link2 size={17}/>}
        {busy ? '正在处理…' : results.some(result => result.error) ? '重试所选' : mode === 'copy' ? '导入歌单' : '关联收藏夹'}
      </button>
    </footer>
  </>
}
