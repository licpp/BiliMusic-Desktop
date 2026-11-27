import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ListChecks, Trash2 } from 'lucide-react'
import type { DownloadRecord } from '../../domain/downloads'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage, removeDownloads } from '../../services/desktopApi'
import { accountKeyAt } from '../../services/queryKeys'
import './download-removal.css'

export const canRetryDownload = (record: DownloadRecord) => record.status === 'failed' || record.status === 'missing'
export const canRemoveDownload = (record: DownloadRecord) => record.status === 'completed' || canRetryDownload(record)
export const downloadTitle = (record: DownloadRecord) => record.track?.displayTitle || record.track?.title
  || record.targetPath.split(/[\\/]/).pop() || '音乐文件'

type PendingRemoval = { records: DownloadRecord[]; epoch: number; batch: boolean }

export function useDownloadRemoval(records: DownloadRecord[]) {
  const client = useQueryClient()
  const [selecting, setSelecting] = useState(false)
  const [ids, setIds] = useState<Set<string>>(() => new Set())
  const [pending, setPending] = useState<PendingRemoval>()
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')
  const [failures, setFailures] = useState<{ id: string; message: string }[]>([])
  const inFlight = useRef<PendingRemoval | undefined>(undefined)
  const eligible = records.filter(canRemoveDownload)
  const selected = eligible.filter(record => ids.has(record.id))

  useEffect(() => {
    const reset = () => {
      inFlight.current = undefined
      setSelecting(false)
      setIds(new Set())
      setPending(undefined)
      setRemoving(false)
      setError('')
      setFailures([])
    }
    window.addEventListener('bilimusic-account-changing', reset)
    return () => {
      inFlight.current = undefined
      window.removeEventListener('bilimusic-account-changing', reset)
    }
  }, [])

  const request = (items: DownloadRecord[], batch = false) => {
    if (inFlight.current || !items.length) return
    setError('')
    setFailures([])
    setPending({ records: items, epoch: accountEpoch(), batch })
  }
  const cancel = () => {
    if (!inFlight.current) setPending(undefined)
  }
  const confirm = async () => {
    if (!pending || pending.epoch !== accountEpoch() || inFlight.current) return
    inFlight.current = pending
    setRemoving(true)
    setError('')
    setFailures([])
    const current = () => inFlight.current === pending && accountEpoch() === pending.epoch
    try {
      const result = await removeDownloads(pending.records.map(record => record.id))
      await client.invalidateQueries({ queryKey: accountKeyAt(pending.epoch, 'downloads') })
      if (!current()) return
      if (result.failed.length) {
        const remaining = new Set(result.failed.map(failure => failure.id))
        setPending({ ...pending, records: pending.records.filter(record => remaining.has(record.id)) })
        if (pending.batch) setIds(remaining)
        setFailures(result.failed)
      } else {
        setPending(undefined)
        if (pending.batch) {
          setIds(new Set())
          setSelecting(false)
        }
      }
    } catch (cause) {
      if (current()) setError(commandErrorMessage(cause, '删除下载失败，请重试'))
    } finally {
      if (current()) {
        inFlight.current = undefined
        setRemoving(false)
      }
    }
  }
  return {
    selecting, selectedCount: selected.length, eligibleCount: eligible.length, ids, pending, removing, error, failures,
    toggle(id: string) {
      if (inFlight.current) return
      setIds(previous => {
        const next = new Set(previous)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    toggleAll: () => setIds(new Set(selected.length === eligible.length ? [] : eligible.map(record => record.id))),
    enter: () => setSelecting(true),
    finish: () => { setSelecting(false); setIds(new Set()) },
    request,
    requestSelected: () => request(selected, true),
    cancel,
    confirm,
  }
}

type Removal = ReturnType<typeof useDownloadRemoval>

export function DownloadSelectionControls({ removal }: { removal: Removal }) {
  const modeButton = useRef<HTMLButtonElement>(null)
  const previous = useRef(removal.selecting)
  const { selecting, eligibleCount, selectedCount, removing } = removal
  useEffect(() => {
    if (previous.current !== selecting) modeButton.current?.focus({ preventScroll: true })
    previous.current = selecting
  }, [selecting])
  if (!eligibleCount && !selecting) return null
  return <div className="download-selection-controls">
    {selecting && <>
      <button type="button" className="collection-flat-button" onClick={removal.toggleAll} disabled={!eligibleCount || removing}>
        {eligibleCount > 0 && selectedCount === eligibleCount ? '取消全选' : '全选'}
      </button>
      <span role="status">已选 {selectedCount} 项</span>
      <button type="button" className="collection-flat-button action-danger" disabled={!selectedCount || removing} onClick={removal.requestSelected}>
        <Trash2 size={15} aria-hidden="true"/>删除所选
      </button>
    </>}
    <button ref={modeButton} type="button" className="collection-flat-button" data-focus="download-selection"
      disabled={removing} onClick={selecting ? removal.finish : removal.enter}>
      {!selecting && <ListChecks size={16} aria-hidden="true"/>}{selecting ? '完成' : '多选'}
    </button>
  </div>
}

export function DownloadSelectButton({ record, removal }: { record: DownloadRecord; removal: Removal }) {
  const checked = removal.ids.has(record.id)
  return <button type="button" className="download-select-button" role="checkbox" data-focus={`select-download-${record.id}`}
    aria-label={`选择 ${downloadTitle(record)}`} aria-checked={checked} disabled={removal.removing}
    onClick={event => { event.stopPropagation(); removal.toggle(record.id) }}>
    <span className="download-check" aria-hidden="true">{checked && <Check size={13} strokeWidth={3}/>}</span>
  </button>
}

export function DownloadRemovalDetails({ removal, keepsExportedFiles }: { removal: Removal; keepsExportedFiles: boolean }) {
  const { pending, error, failures } = removal
  if (!pending) return null
  const single = !pending.batch ? pending.records[0] : undefined
  const completed = pending.records.some(record => record.status === 'completed')
  return <>
    {single ? <p className="download-removal-name">{downloadTitle(single)}</p> : <p>删除选中的 {pending.records.length} 项下载？</p>}
    <p>{completed
      ? keepsExportedFiles ? '删除应用内的离线副本。系统下载目录中已导出的文件会保留。' : '删除本机的离线副本，歌曲仍保留在原歌单和收藏中。'
      : '仅移除下载记录。'}</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {failures.length > 0 && <div className="download-removal-failures" role="alert">
      <p>{failures.length} 项未能删除，可重试。</p>
      <ul>{[...new Set(failures.map(failure => commandErrorMessage(failure.message, '删除下载失败，请重试')))].map(message => <li key={message}>{message}</li>)}</ul>
    </div>}
  </>
}
