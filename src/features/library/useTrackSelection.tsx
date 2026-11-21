import { BatchMatchButton } from './BatchMatchButton'
import { accountEpoch } from '../../services/accountScope'
import { useEffect, useRef, useState } from 'react'
import { Download, EyeOff, FolderPlus, ListPlus } from 'lucide-react'
import type { Track } from '../../domain/track'
import { commandErrorMessage } from '../../services/desktopApi'
import { useDownloadBatch } from '../downloads/downloadBatch'
import { chooseDownload } from '../downloads/downloadRequest'
import { downloadSelectionMessage, prepareDownloadSelection } from '../downloads/downloadSelection'
import { usePlayerStore } from '../player/playerStore'
import { chooseTrackPlaylist } from './trackActionStore'

export function useTrackSelection(tracks: Track[]) {
  const [selecting, setSelecting] = useState(false)
  const [ids, setIds] = useState<Set<string>>(() => new Set())
  const selected = tracks.filter(track => ids.has(track.id))
  const toggle = (id: string) => setIds(existing => {
    const next = new Set(existing)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const exit = () => { setSelecting(false); setIds(new Set()) }
  return {
    selecting, ids, selected, toggle, exit,
    forget: (removed: string[]) => {
      const exclude = new Set(removed)
      setIds(existing => new Set([...existing].filter(id => !tracks.some(track => track.id === id && exclude.has(track.source.bvid)))))
    },
    enter: () => setSelecting(true),
    all: () => setIds(selected.length === tracks.length ? new Set() : new Set(tracks.map(track => track.id))),
  }
}

export function BatchTrackActions({ selection, total, onRemove, onHide, downloadScope, allowAutoMatch = false }: {
  selection: ReturnType<typeof useTrackSelection>
  total: number
  allowAutoMatch?: boolean
  downloadScope?: string
  onHide?: (tracks: Track[]) => Promise<void>
  onRemove?: (tracks: Track[]) => Promise<void>
}) {
  const { selected, all, exit } = selection
  const downloading = useDownloadBatch(state => state.busy)
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const download = async () => {
    const epoch = accountEpoch()
    const current = () => alive.current && accountEpoch() === epoch
    setRemoving(true)
    setMessage('')
    try {
      const result = await prepareDownloadSelection(selected, downloadScope, current)
      if (!result || !current()) return
      chooseDownload(result.tracks)
      setMessage(downloadSelectionMessage(result.failed, result.tracks.length))
    } catch (cause) {
      if (current()) setMessage(commandErrorMessage(cause))
    } finally {
      if (current()) setRemoving(false)
    }
  }
  return <>
    <div className="collection-actions batch-actions">
      <button onClick={all} disabled={removing}>{selected.length === total ? '取消全选' : '全选'}</button>
      <span role="status">已选 {selected.length} 首</span>
      <button disabled={!selected.length || removing} onClick={() => { usePlayerStore.getState().enqueue(selected); setMessage(`已加入队列 ${selected.length} 首`) }}><ListPlus size={16}/>加入队列</button>
      <button disabled={!selected.length || removing} onClick={async () => {
        setRemoving(true)
        try {
          const scope = accountEpoch()
          if (scope === accountEpoch()) chooseTrackPlaylist(selected)
        } catch(cause) { setMessage(commandErrorMessage(cause)) }
        finally { setRemoving(false) }
      }}><FolderPlus size={16}/>加入歌单</button>
      {selected.some(track => track.source.provider === 'bilibili') && <button disabled={downloading || removing} onClick={() => void download()}><Download size={16}/>下载所选</button>}
      {allowAutoMatch && <BatchMatchButton tracks={selected}/>}
      {onHide && <button disabled={!selected.length || removing} onClick={async()=>{setRemoving(true);try{await onHide(selected)}catch(e){setMessage(commandErrorMessage(e))}finally{setRemoving(false)}}}><EyeOff size={16}/>隐藏所选</button>}
      {onRemove && <button disabled={!selected.length || removing} onClick={() => setConfirmRemove(true)}>移除所选</button>}
      <button onClick={exit} disabled={removing}>完成</button>
    </div>
    {confirmRemove && onRemove && <div className="collection-actions batch-actions">
      <span>从当前歌单移除已选的 {selected.length} 首歌曲？</span>
      <button disabled={removing || !selected.length} onClick={async () => {
        setRemoving(true)
        try { await onRemove(selected); exit() }
        catch (cause) { setMessage(commandErrorMessage(cause)) }
        finally { setRemoving(false); setConfirmRemove(false) }
      }}>确认移除</button>
      <button disabled={removing} onClick={() => setConfirmRemove(false)}>取消</button>
    </div>}
    {message && <p role="status" className="batch-message">{message}</p>}
  </>
}
