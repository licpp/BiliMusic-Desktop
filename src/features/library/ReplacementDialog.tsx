import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, LoaderCircle, Music2, Play, Search, X } from 'lucide-react'
import type { ImportedEntry, ImportedEntriesSnapshot } from '../../domain/importedEntry'
import type { BiliSearchItem } from '../../domain/bilibili'
import { importKeyword, type ImportChoice } from '../../services/playlistImportModel'
import type { Track } from '../../domain/track'
import { searchReplacementVideos, resolveReplacementVideo } from '../../services/playlistImport'
import { loadImportedEntries, replaceImportedEntry } from '../../services/importedEntries'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage } from '../../services/desktopApi'
import { Artwork } from '../../shared/Artwork'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { formatDuration } from '../../shared/time'
import { playbackIntent, usePlayerStore } from '../player/playerStore'
import { refreshImportedPlayback } from '../player/importedPlayback'
import '../../styles/components/import-matching.css'

export function formatMatchPlayCount(value: number) {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`
  return String(Math.max(0, Math.floor(value)))
}

export type ReplacementProps = { entry: ImportedEntry; session: string; currentTrack?: Track; onSaved: (snapshot: ImportedEntriesSnapshot) => void; onClose: () => void }

export function ReplacementDialog(props: ReplacementProps) {
  return <CollectionDialog title="更换视频" mobileSheet className="import-match-dialog" onClose={props.onClose}><ReplacementSearch {...props}/></CollectionDialog>
}

/** Shared content: desktop dialog, mobile sheet and remote-friendly large dialog
 * use exactly the same search/selection flow. Only the outer window differs. */
export function ReplacementSearch({ entry, session, currentTrack, onSaved, onClose }: ReplacementProps) {
  const [target,setTarget]=useState(entry),[writeSession,setWriteSession]=useState(session),[removed,setRemoved]=useState(false)
  const [keyword, setKeyword] = useState(importKeyword(entry.song))
  const [results, setResults] = useState<BiliSearchItem[]>([])
  const [page, setPage] = useState(0), [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [notice,setNotice]=useState('')
  const [expanded, setExpanded] = useState<string>(), [parts, setParts] = useState<ImportChoice[]>([])
  const [resolving, setResolving] = useState<string>()
  const abort = useRef<AbortController | null>(null), request = useRef(0), mounted = useRef(true)
  const entryIdentity=useRef(entry.entryId),savingEntry=useRef<string|undefined>(undefined)
  entryIdentity.current=entry.entryId
  const submitted = useRef(keyword)
  const valid = (ticket: number, epoch: number, signal: AbortSignal) => mounted.current && ticket === request.current && epoch === accountEpoch() && !signal.aborted
  const search = async (nextPage = 1, initialTerm?:string) => {
    const term = nextPage === 1 ? (initialTerm??keyword).trim() : submitted.current
    if (!term || !initialTerm && (saving || removed)) return
    abort.current?.abort()
    const controller = new AbortController(); abort.current = controller
    const ticket = ++request.current, epoch = accountEpoch()
    if (nextPage === 1) { submitted.current = term; setResults([]); setExpanded(undefined); setParts([]); setPage(0);setHasMore(false) }
    setBusy(true); setResolving(undefined); setError('');setNotice('')
    try {
      const response = await searchReplacementVideos(term, nextPage, controller.signal)
      if (!valid(ticket, epoch, controller.signal)) return
      setResults(previous => {
        const values = nextPage === 1 ? [] : previous
        const seen = new Set(values.map(item => item.bvid))
        return [...values, ...response.items.filter(item => !seen.has(item.bvid) && Boolean(seen.add(item.bvid)))]
      })
      setPage(response.page)
      setHasMore(response.items.length > 0 && response.page * response.pageSize < response.total)
    } catch (cause) { if (valid(ticket, epoch, controller.signal)) setError(commandErrorMessage(cause)) }
    finally { if (valid(ticket, epoch, controller.signal)) setBusy(false) }
  }
  useEffect(() => {
    mounted.current = true
    setSaving(false);setResolving(undefined);setBusy(false)
    const term=importKeyword(entry.song);setKeyword(term)
    void search(1,term)
    const close = () => onClose()
    window.addEventListener('bilimusic-account-changing', close)
    return () => { mounted.current = false; ++request.current; abort.current?.abort(); window.removeEventListener('bilimusic-account-changing', close) }
  }, [entry.entryId])
  useEffect(()=>{setTarget(entry);setWriteSession(session);setRemoved(false)},[entry.entryId,entry.revision,session])
  const useChoice = async (choice: ImportChoice) => {
    if (savingEntry.current===target.entryId || removed) return
    savingEntry.current=target.entryId
    setSaving(true); setError('');setNotice('')
    const epoch = accountEpoch(),ticket=request.current,targetId=target.entryId,intent=playbackIntent()
    const current=()=>mounted.current&&epoch===accountEpoch()&&ticket===request.current&&entryIdentity.current===targetId
    try {
      const snapshot = await replaceImportedEntry(target, choice, writeSession)
      if (current()) { refreshImportedPlayback(target, choice, snapshot, intent); onSaved(snapshot) }
    } catch (cause) {
      if (!current()) return
      setError(commandErrorMessage(cause))
      // A different device may have replaced or removed the entry while this
      // panel was open. Refresh the local canonical revision before retrying.
      try {
        const snapshot=await loadImportedEntries(target.playlistId)
        if(!current())return
        const latest=snapshot.entries.find(value=>value.entryId===target.entryId)
        if(!latest){setRemoved(true);setError('这首歌已从歌单移除');return}
        setTarget(latest);setWriteSession(snapshot.session)
        if(latest.revision!==target.revision)setError('这首歌的选择已更新，请重新选择视频')
      } catch { /* Keep the original write error and the old binding intact. */ }
    }
    finally { if(savingEntry.current===targetId)savingEntry.current=undefined;if (current()) setSaving(false) }
  }
  const preview = async (choice: ImportChoice) => {
    const epoch=accountEpoch(),ticket=request.current
    try { await usePlayerStore.getState().play(choice.track) }
    catch (cause) { if (mounted.current&&epoch===accountEpoch()&&ticket===request.current) setError(commandErrorMessage(cause)) }
  }
  const resolve = async (item: BiliSearchItem, listen = false) => {
    if (saving || resolving || removed) return
    abort.current?.abort()
    const controller = new AbortController(); abort.current = controller
    const ticket = ++request.current, epoch = accountEpoch()
    setBusy(false); setResolving(item.bvid); setExpanded(item.bvid); setParts([]); setError('');setNotice('')
    try {
      const choices = await resolveReplacementVideo(item.bvid, controller.signal)
      if (!valid(ticket, epoch, controller.signal)) return
      if (!choices.length) { setError('这个视频暂时没有可用的分 P'); return }
      if (choices.length === 1) { if (listen) await preview(choices[0]); else if(choices[0].track.id===target.trackId)setNotice('已在使用这个视频');else await useChoice(choices[0]) }
      else setParts(choices)
    } catch (cause) { if (valid(ticket, epoch, controller.signal)) setError(commandErrorMessage(cause)) }
    finally { if (valid(ticket, epoch, controller.signal)) setResolving(undefined) }
  }
  return <div className="import-match-content">
    <div className="import-match-origin"><Artwork src={target.song.coverUrl} fallback={<Music2/>}/><div><strong>{target.song.title}</strong><span>{target.song.artists.join(' / ') || '歌手未知'}{target.song.durationSeconds ? ` · ${formatDuration(target.song.durationSeconds)}` : ''}</span>{currentTrack&&currentTrack.id===target.trackId&&<span className="import-match-current" title={currentTrack.videoTitle||currentTrack.title}>当前视频：{currentTrack.videoTitle||currentTrack.title}</span>}</div></div>
    <form className="import-match-search" onSubmit={event => { event.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); void search() }}>
      <Search size={19} aria-hidden="true"/><input data-dialog-autofocus data-primary-focus data-focus="replacement-search" aria-label="搜索替换视频" placeholder="搜索视频，或粘贴 BV / 链接" value={keyword} disabled={saving||removed} onChange={event => setKeyword(event.target.value)}/>
      {keyword && <button type="button" className="import-match-clear" aria-label="清空搜索" disabled={saving} onClick={() => setKeyword('')}><X size={15}/></button>}
      <button type="submit" className="import-match-submit" disabled={busy || saving || removed || !keyword.trim()}>{busy && page === 0 ? <LoaderCircle size={17} className="spin"/> : '搜索'}</button>
    </form>
    {error && <p className="import-match-error" role="alert">{error}</p>}
    {notice&&<p className="import-match-notice" role="status">{notice}</p>}
    <div className="import-match-results" aria-busy={busy}>
      {results.map(item => <article className="import-match-result" key={item.bvid}>
        <div className="import-match-video">
          <button data-focus={`replacement-preview-${item.bvid}`} className="import-match-cover" disabled={saving || removed || Boolean(resolving)} aria-label={`试听 ${item.title}`} onClick={() => void resolve(item, true)}><Artwork src={item.coverUrl} adaptAspect/><span className="import-match-cover-overlay"><Play size={18} fill="currentColor"/></span></button>
          <div className="import-match-copy"><strong title={item.title}>{item.title}</strong><span className="import-match-uploader">{item.uploaderName}</span><span className="import-match-facts"><span>{formatMatchPlayCount(item.playCount)} 次播放</span><span>{formatDuration(item.durationSeconds)}</span></span></div>
          <button data-primary-focus data-focus={`replacement-use-${item.bvid}`} className="import-match-use" disabled={saving || removed || Boolean(resolving)} onClick={() => void resolve(item)} aria-label={`选择视频 ${item.title}`}>{resolving === item.bvid ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>}<span>选择</span></button>
        </div>
        {expanded === item.bvid && parts.length > 1 && <div className="import-match-parts"><p>选择分 P</p>{parts.map(choice => <div className="import-match-part" key={choice.track.id}><button className="import-match-part-play" aria-label={`试听 ${choice.track.title}`} disabled={saving||removed} onClick={() => void preview(choice)}><Play size={16}/></button><span><strong>{choice.evidence.partTitle || choice.track.title}</strong><small>{formatDuration(choice.track.durationSeconds)}</small></span><button className="import-match-use" disabled={saving || removed || choice.track.id === target.trackId} onClick={() => void useChoice(choice)}>{saving ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}<span>{choice.track.id === target.trackId ? '已选' : '使用'}</span></button></div>)}</div>}
      </article>)}
      {!busy && !error && !results.length && <p className="import-match-empty">没有找到视频，试试其他关键词。</p>}
      {busy && <p className="import-match-loading" role="status"><LoaderCircle size={18} className="spin"/>正在搜索…</p>}
      {hasMore && <button className="import-match-more" disabled={busy || saving || Boolean(resolving)} onClick={() => void search(page + 1)}><ChevronDown size={17}/>更多结果</button>}
    </div>
    <div className="import-match-footer"><button type="button" disabled={saving} onClick={onClose}>取消</button>{saving && <span role="status"><LoaderCircle size={16} className="spin"/>正在保存…</span>}</div>
  </div>
}

export function ImportMatchDialogFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <CollectionDialog title={title} mobileSheet className="import-match-dialog" onClose={onClose}>{children}</CollectionDialog>
}
