import { ChevronDown, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { checkHistoryCloudPresence, commandErrorMessage, removeHistoryRecords } from '../../services/desktopApi'
import { CollectionDialog } from '../../shared/CollectionDialog'

export type CloudPresence =
  | { state: 'checking' }
  | { state: 'ready'; cloudIds: string[]; historySync: boolean; checked: boolean }
  | { state: 'failed'; error: string }

/** Delete-confirmation for the recent list: checks the cloud first so the choice is only
 *  offered when the selected records actually exist there. */
export function HistoryDeleteDialog({ tracks, onClose, onDeleted }: {
  tracks: Track[]
  onClose: () => void
  onDeleted: (removed: number) => void
}) {
  const [presence, setPresence] = useState<CloudPresence>({ state: 'checking' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    const epoch = accountEpoch()
    checkHistoryCloudPresence(tracks.map(track => track.id))
      .then(result => { if (alive.current && epoch === accountEpoch()) setPresence({ state: 'ready', ...result }) })
      .catch(cause => { if (alive.current && epoch === accountEpoch()) setPresence({ state: 'failed', error: commandErrorMessage(cause) }) })
    return () => { alive.current = false }
  }, [tracks])
  const remove = async (cloud: boolean) => {
    if (busy) return
    const epoch = accountEpoch()
    const current = () => alive.current && epoch === accountEpoch()
    setBusy(true)
    setError('')
    try {
      const removed = await removeHistoryRecords(tracks.map(track => track.id), cloud)
      if (current()) onDeleted(removed)
    } catch (cause) {
      if (current()) setError(commandErrorMessage(cause))
    } finally {
      if (current()) setBusy(false)
    }
  }
  return <CollectionDialog title="删除播放记录" mobileSheet canClose={() => !busy}
    onClose={() => { if (!busy) onClose() }}>
    <HistoryDeletePanel count={tracks.length} presence={presence} busy={busy} error={error}
      onCancel={onClose} onRemove={cloud => void remove(cloud)}/>
  </CollectionDialog>
}

export function HistoryDeletePanel({ count, presence, busy, error, onCancel, onRemove }: {
  count: number
  presence: CloudPresence
  busy: boolean
  error: string
  onCancel: () => void
  onRemove: (cloud: boolean) => void
}) {
  const cloudCount = presence.state === 'ready' ? presence.cloudIds.length : 0
  const checked = presence.state === 'ready' && presence.checked
  const summary = presence.state === 'checking' ? '正在核对云端播放记录…'
    : presence.state === 'failed' ? '无法核对云端记录，只能删除本机。'
    : !checked ? '云同步未连接，只能删除本机记录。'
    : cloudCount ? `其中 ${cloudCount} 条也在云端同步里${presence.historySync ? '，仅删除本机下次同步会恢复' : ''}。`
    : '云端没有这些记录，只删除本机记录。'
  return <>
    <p>已选 {count} 首歌曲。删除后它们不再出现在“最近播放”。</p>
    <details className="history-delete-details">
      <summary>{presence.state === 'checking' && <LoaderCircle className="spin" size={14}/>}{summary}<ChevronDown size={14}/></summary>
      <p>收藏、歌单和下载不受影响，删除不会清除续播进度。</p>
      {presence.state === 'failed' && <p>无法核对云端记录：{presence.error}。如果云端仍有这些记录，下次同步可能让它们重新出现。</p>}
      {presence.state === 'ready' && !presence.checked && presence.historySync && <p>已开启“同步播放记录”：如果云端仍有这些记录，恢复连接并同步后可能重新出现。</p>}
      {cloudCount > 0 && presence.state === 'ready' && presence.historySync && <p>已开启“同步播放记录”：仅删除本机时，下次同步会把云端记录带回来。</p>}
      {cloudCount > 0 && <p>删除云端会在下一次同步时生效，其他设备同步后也会移除这些记录。</p>}
    </details>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <footer className="collection-actions">
      <button type="button" className="collection-flat-button" disabled={busy} onClick={onCancel}>取消</button>
      {cloudCount > 0 && <button type="button" className="collection-flat-button" disabled={busy} onClick={() => onRemove(true)}>同时删除云端</button>}
      <button type="button" className="collection-flat-button action-danger" disabled={busy || presence.state === 'checking'} onClick={() => onRemove(false)}>{busy ? '正在删除…' : cloudCount > 0 ? '仅删除本机' : '删除'}</button>
    </footer>
  </>
}
