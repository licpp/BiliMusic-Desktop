import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { checkHistoryDeletionScope, commandErrorMessage, removeHistoryRecords } from '../../services/desktopApi'
import { CollectionDialog } from '../../shared/CollectionDialog'

type DeletionScope =
  | { state: 'checking' }
  | { state: 'ready'; canSync: boolean }
  | { state: 'failed'; error: string }

export function HistoryDeleteDialog({ tracks, onClose, onDeleted, renderDialog }: {
  tracks: Track[]
  onClose: () => void
  onDeleted: () => void
  renderDialog?: (body: ReactNode, close: () => void) => ReactNode
}) {
  const [scope, setScope] = useState<DeletionScope>({ state: 'checking' })
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    let current = true
    const epoch = accountEpoch()
    setScope({ state: 'checking' })
    checkHistoryDeletionScope()
      .then(result => { if (current && epoch === accountEpoch()) setScope({ state: 'ready', ...result }) })
      .catch(cause => { if (current && epoch === accountEpoch()) setScope({ state: 'failed', error: commandErrorMessage(cause) }) })
    return () => { current = false }
  }, [retry])

  const close = () => { if (!deleting.current) onClose() }
  const remove = async () => {
    if (deleting.current || scope.state !== 'ready') return
    const epoch = accountEpoch()
    const current = () => alive.current && epoch === accountEpoch()
    deleting.current = true
    setBusy(true)
    setError('')
    try {
      await removeHistoryRecords(tracks.map(track => track.id))
      if (current()) onDeleted()
    } catch (cause) {
      if (current()) setError(commandErrorMessage(cause))
    } finally {
      deleting.current = false
      if (current()) setBusy(false)
    }
  }

  const body = <HistoryDeletePanel count={tracks.length} scope={scope} busy={busy} error={error}
    onCancel={close} onRemove={() => void remove()} onRetry={() => setRetry(attempt => attempt + 1)}/>
  if (renderDialog) return renderDialog(body, close)
  return <CollectionDialog title="删除播放记录" mobileSheet
    canClose={() => !deleting.current} onClose={close}>{body}</CollectionDialog>
}

export function HistoryDeletePanel({ count, scope, busy, error, onCancel, onRemove, onRetry }: {
  count: number
  scope: DeletionScope
  busy: boolean
  error: string
  onCancel: () => void
  onRemove: () => void
  onRetry: () => void
}) {
  return <>
    <p>从最近播放中删除 {count} 首歌曲？</p>
    {scope.state === 'checking' && <p className="history-delete-scope" role="status">正在读取同步设置…</p>}
    {scope.state === 'ready' && <p className="history-delete-scope">{scope.canSync ? '其他设备将在下次同步时移除。' : '仅删除本机播放记录。'}</p>}
    {scope.state === 'failed' && <p role="alert" className="inline-error">{scope.error}</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <footer className="collection-actions history-delete-actions">
      <button type="button" className="collection-flat-button" data-dialog-autofocus disabled={busy} onClick={onCancel}>取消</button>
      {scope.state === 'failed'
        ? <button type="button" className="collection-flat-button" onClick={onRetry}>重试</button>
        : <button type="button" className="collection-flat-button action-danger" disabled={busy || scope.state !== 'ready'} onClick={onRemove}>{busy ? '正在删除…' : '删除'}</button>}
    </footer>
  </>
}
