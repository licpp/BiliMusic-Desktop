import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, LoaderCircle, Music2, Pause, RefreshCw, Search, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { Playlist } from '../../domain/library'
import type { ImportedEntry, ImportedEntriesSnapshot } from '../../domain/importedEntry'
import { accountEpoch } from '../../services/accountScope'
import { accountQueryKey } from '../../services/queryKeys'
import { commandErrorMessage } from '../../services/desktopApi'
import { pausePlaylistImport, retryMissingImportedPlaylist, usePlaylistImport } from '../../services/playlistImport'
import { Artwork } from '../../shared/Artwork'
import { formatDuration } from '../../shared/time'
import { useImportedPlaylist } from './useImportedPlaylist'
import { ImportMatchDialogFrame, ReplacementDialog, type ReplacementProps } from './ReplacementDialog'

export function ImportedPlaylistCompletion({ playlist, onClose }: { playlist: Playlist; onClose: () => void }) {
  return <ImportMatchDialogFrame title="补全未匹配" onClose={onClose}><ImportedPlaylistCompletionContent playlist={playlist} onClose={onClose}/></ImportMatchDialogFrame>
}

export function ImportedPlaylistCompletionContent({ playlist, onClose, renderReplacement }: { playlist: Playlist; onClose: () => void; renderReplacement?: (props: ReplacementProps) => ReactNode }) {
  const query = useImportedPlaylist(playlist), client = useQueryClient()
  const job = usePlaylistImport(state => state.job?.playlistId === playlist.id ? state.job : null)
  const running = Boolean(job && ['matching', 'waiting', 'saving'].includes(job.state))
  const [filter, setFilter] = useState(''), [limit, setLimit] = useState(40), [error, setError] = useState('')
  const [replacement, setReplacement] = useState<ImportedEntry>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const close = () => onClose()
    window.addEventListener('bilimusic-account-changing', close)
    return () => { mounted.current = false; window.removeEventListener('bilimusic-account-changing', close) }
  }, [playlist.id])
  const retry = async (entryId?: string) => {
    setError('')
    const epoch = accountEpoch()
    try { await retryMissingImportedPlaylist(playlist, entryId) }
    catch (cause) { if (mounted.current && epoch === accountEpoch()) setError(commandErrorMessage(cause)) }
    finally { if (mounted.current && epoch === accountEpoch()) { void query.refetch(); void client.invalidateQueries({ queryKey: accountQueryKey('library') }); void client.invalidateQueries({ queryKey: accountQueryKey('playlists') }) } }
  }
  const saved = (snapshot: ImportedEntriesSnapshot) => {
    client.setQueryData(accountQueryKey('imported-entries', playlist.id), snapshot)
    void client.invalidateQueries({ queryKey: accountQueryKey('library') })
    void client.invalidateQueries({ queryKey: accountQueryKey('playlists') })
    setReplacement(undefined)
  }
  const needle = filter.trim().toLocaleLowerCase()
  const rows = query.missing.filter(entry => `${entry.song.title} ${entry.song.artists.join(' ')}`.toLocaleLowerCase().includes(needle))
  const replacementProps: ReplacementProps | undefined = replacement && query.data ? { entry: replacement, session: query.data.session, onSaved: saved, onClose: () => setReplacement(undefined) } : undefined
  return <div className="import-completion-content">
    <div className="import-completion-summary"><div><strong>{playlist.name}</strong><span>{query.isPending ? '正在读取歌曲…' : query.missing.length ? `${query.missing.length} 首待补全` : '歌曲已全部匹配'}</span></div>{running ? <button data-focus="completion-pause" className="import-match-use" onClick={pausePlaylistImport}><Pause size={17}/><span>暂停</span></button> : <button data-focus="completion-retry-all" className="import-match-use" disabled={!query.missing.length || query.isPending} onClick={() => void retry()}><RefreshCw size={17}/><span>全部重试</span></button>}</div>
    {running && <p className="import-match-loading" role="status"><LoaderCircle className="spin" size={16}/>{job?.message || '正在匹配…'}</p>}
    {query.missing.length > 0 && <label className="import-match-search import-completion-search"><Search size={18}/><input aria-label="查找未匹配歌曲" placeholder="查找未匹配歌曲" value={filter} onChange={event => { setFilter(event.target.value); setLimit(40) }}/>{filter && <button className="import-match-clear" aria-label="清空查找" onClick={() => { setFilter(''); setLimit(40) }}><X size={15}/></button>}</label>}
    {(error || query.error) && <div className="import-match-error" role="alert"><span>{error || commandErrorMessage(query.error)}</span>{query.error && <button onClick={() => void query.refetch()}>重试</button>}</div>}
    <div className="import-completion-results">
      {rows.slice(0, limit).map(entry => <article className="import-completion-row" key={entry.entryId}>
        <span className="import-completion-position">{entry.order + 1}</span><Artwork src={entry.song.coverUrl} fallback={<Music2/>}/>
        <div className="import-completion-copy"><strong>{entry.song.title}</strong><span>{entry.song.artists.join(' / ') || '歌手未知'}{entry.song.durationSeconds ? ` · ${formatDuration(entry.song.durationSeconds)}` : ''}</span>{entry.message&&<small className="import-completion-message">{entry.message}</small>}</div>
        <div className="import-completion-actions"><button data-focus={`completion-retry-${entry.entryId}`} disabled={running} aria-label={`重新匹配 ${entry.song.title}`} title="重新匹配" onClick={() => void retry(entry.entryId)}><RefreshCw size={17}/></button><button data-focus={`completion-find-${entry.entryId}`} className="import-match-use" onClick={() => setReplacement(entry)}><Search size={16}/><span>查找</span></button></div>
      </article>)}
      {rows.length > limit && <button className="import-match-more" onClick={() => setLimit(value => value + 40)}><ChevronDown size={17}/>更多歌曲</button>}
      {!query.isPending && !query.error && !rows.length && <div className="import-completion-empty">{query.missing.length ? <Search size={25}/> : <Check size={28}/>}<p>{query.missing.length ? '没有符合关键词的歌曲' : '没有待补全的歌曲'}</p></div>}
      {query.isPending && <p className="import-match-loading"><LoaderCircle className="spin" size={18}/>正在读取…</p>}
    </div>
    <div className="import-match-footer"><button data-focus="completion-done" type="button" onClick={onClose}>完成</button></div>
    {replacementProps && (renderReplacement ? renderReplacement(replacementProps) : <ReplacementDialog {...replacementProps}/>)}
  </div>
}
