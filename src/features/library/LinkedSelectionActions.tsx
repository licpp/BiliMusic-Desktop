import { useEffect, useRef, useState } from 'react'
import { Download, FolderPlus, ListPlus } from 'lucide-react'
import { ActionMenu } from '../../shared/ActionMenu'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage, removeLinkedVideos } from '../../services/desktopApi'
import type { LinkedFolder } from '../../domain/bilibili'
import type { Track } from '../../domain/track'
import { chooseDownload } from '../downloads/downloadRequest'
import { downloadSelectionMessage, prepareDownloadSelection } from '../downloads/downloadSelection'
import { usePlayerStore } from '../player/playerStore'
import { chooseTrackPlaylist } from './trackActionStore'
import { useTrackSelection } from './useTrackSelection'
import { resolveLinkedSelection } from './linkedSelection'

export function LinkedSelectionActions({ folderId, selection, total, onFolderChanged, confirmDialog, onChoosePlaylist = chooseTrackPlaylist, toolbarClass = 'collection-actions batch-actions', compact = false }: {
  folderId: number
  selection: ReturnType<typeof useTrackSelection>
  total: number
  onFolderChanged: (folder: LinkedFolder) => void
  confirmDialog: (children: React.ReactNode, close: () => void) => React.ReactNode
  onChoosePlaylist?: (tracks: Track[]) => void
  toolbarClass?: string
  compact?: boolean
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState<string[]>()
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const run = async (action: () => Promise<void>) => {
    const epoch = accountEpoch()
    setBusy(true); setMessage('')
    try { await action() }
    catch (cause) { if (alive.current && epoch === accountEpoch()) setMessage(commandErrorMessage(cause)) }
    finally { if (alive.current && epoch === accountEpoch()) setBusy(false) }
  }
  const apply = (target: 'queue' | 'playlist' | 'download') => run(async () => {
    if (target === 'download') {
      const result = await prepareDownloadSelection(selection.selected, undefined, () => alive.current)
      if (!result) return
      chooseDownload(result.tracks)
      setMessage(downloadSelectionMessage(result.failed, result.tracks.length))
      return
    }
    const result = await resolveLinkedSelection(selection.selected, () => alive.current)
    if (!result) return
    const { tracks, failed } = result
    if (tracks.length) {
      if (target === 'queue') usePlayerStore.getState().enqueue(tracks)
      else onChoosePlaylist(tracks)
    }
    if (failed) setMessage(`${failed} 个视频未能读取可用分 P。`)
    else if (target === 'queue') setMessage(`已加入队列 ${tracks.length} 首`)
  })
  const remove = (ids: string[]) => run(async () => {
    const epoch = accountEpoch()
    const result = await removeLinkedVideos(folderId, ids)
    if (epoch !== accountEpoch() || !alive.current) return
    onFolderChanged(result.folder)
    selection.forget(result.removed)
    setMessage(result.failed.length ? `已移除 ${result.removed.length} 个，失败 ${result.failed.length} 个：${result.failed[0].message}` : `已从 B 站收藏夹移除 ${result.removed.length} 个视频`)
  })
  const selectedCount = selection.selected.length
  const actions = (close?: () => void) => [
    { label: '加入队列', icon: <ListPlus size={16}/>, run: () => void apply('queue') },
    { label: '加入歌单', icon: <FolderPlus size={16}/>, run: () => void apply('playlist') },
    { label: '下载所选', icon: <Download size={16}/>, run: () => void apply('download') },
    { label: '移除所选', title: '每次最多移除 50 个视频', disabled: selectedCount > 50, run: () => setConfirmed(selection.selected.map(track => track.source.bvid)) },
  ].map(action => <button key={action.label} type="button" role={close ? 'menuitem' : undefined} title={action.title}
    disabled={!selectedCount || busy || action.disabled} onClick={() => { close?.(); action.run() }}>{action.icon}{action.label}</button>)
  return <>
    <div className={compact ? `${toolbarClass} linked-selection-controls` : toolbarClass} role="toolbar" aria-label="已选视频操作">
      <button type="button" onClick={selection.all} disabled={!total || busy}>{selectedCount === total && total > 0 ? '取消全选' : '全选'}</button>
      <span role="status">已选 {selectedCount}{compact ? '' : ' 个视频'}</span>
      {compact ? <ActionMenu label="批量操作" sheet>{actions}</ActionMenu> : actions()}
      <button type="button" disabled={busy} onClick={selection.exit}>完成</button>
    </div>
    {(message || busy) && <p className="batch-message" role="status">{busy ? '正在处理…' : message}</p>}
    {confirmed && confirmDialog(<>
      <p>从 B 站收藏夹移除已选的 {confirmed.length} 个完整视频及其全部分 P？</p>
      <footer className={toolbarClass}>
        <button type="button" className="collection-flat-button" onClick={() => setConfirmed(undefined)}>取消</button>
        <button type="button" className="collection-flat-button action-danger" onClick={() => { setConfirmed(undefined); void remove(confirmed) }}>确认移除</button>
      </footer>
    </>, () => setConfirmed(undefined))}
  </>
}
