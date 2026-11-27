import { useMatchMetadataPreference } from '../features/lyrics/useMatchMetadataPreference'
import { accountKeyAt } from '../services/queryKeys'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, LoaderCircle, RefreshCw, Search } from 'lucide-react'
import type { Track } from '../domain/track'
import { accountEpoch } from '../services/accountScope'
import { clearStoredLyrics, commandErrorMessage, getStoredLyrics, searchLyrics } from '../services/desktopApi'
import { lyricsWereCleared, type LyricCandidate, type StoredLyrics } from '../domain/lyrics'
import { hasTimedLyrics } from '../domain/lrc'
import { firstSongQuery } from '../domain/songIdentity'
import { rankLyricCandidates } from '../services/musicMatchRanking'
import { LargeDialog } from './LargeDialog'
import { LyricMatchActions } from '../features/lyrics/LyricMatchActions'
import { saveTrackLyrics } from '../features/lyrics/saveTrackLyrics'

export function LargeLyricSearch({ track, stored: present, onSaved, onClose }: { track: Track; stored?: StoredLyrics | null; onSaved?: (value: StoredLyrics) => void; onClose: () => void }) {
  const initial = firstSongQuery(track), epoch = useRef(accountEpoch()).current
  const [title, setTitle] = useState(initial.title), [artist, setArtist] = useState(initial.artist)
  const [submitted, setSubmitted] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [updateMetadata, setUpdateMetadata] = useMatchMetadataPreference()
  const client = useQueryClient()
  const alive = useRef(true), saving = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const results = useQuery({ queryKey: accountKeyAt(epoch, 'large-lyric-search', submitted.title, submitted.artist), queryFn: () => searchLyrics(submitted.title, submitted.artist || undefined, true), enabled: Boolean(submitted.title.trim()), retry: false })
  const candidates = rankLyricCandidates(results.data?.candidates || [], submitted.title, submitted.artist, track.durationSeconds)
  const selection = useQuery({queryKey: accountKeyAt(epoch, 'lyric-editor', track.id), queryFn: () => getStoredLyrics(track.id), enabled: present === undefined, staleTime: 0, retry: false})
  const stored = present === undefined ? selection.data : present
  const valid = () => alive.current && epoch === accountEpoch()
  async function save(work: () => Promise<StoredLyrics | undefined>) {
    if (saving.current || !valid()) return
    saving.current = true
    setBusy(true); setError('')
    try {
      const value = await work()
      if (value && valid()) {
        const key = accountKeyAt(epoch, 'lyric-editor', track.id)
        void client.cancelQueries({ queryKey: key, exact: true }, { revert: false })
        client.setQueryData(key, value)
        onSaved?.(value); onClose()
      }
    } catch (cause) { if (valid()) setError(commandErrorMessage(cause)) }
    finally { saving.current = false; if (valid()) setBusy(false) }
  }
  const choose = (candidate: LyricCandidate) => save(() => saveTrackLyrics(track, candidate, updateMetadata, client, valid))
  return <LargeDialog title={stored && !lyricsWereCleared(stored) ? "更换歌词" : "匹配歌词"} className="large-lyric-search" onClose={() => { if (!saving.current) onClose() }}>
    <form onSubmit={e => { e.preventDefault(); const next = { title: title.trim(), artist: artist.trim() }; if (!next.title) return; setError(''); if (next.title === submitted.title && next.artist === submitted.artist) void results.refetch(); else setSubmitted(next) }}>
      <div className="large-lyric-fields"><label className="large-search"><input data-primary-focus aria-label="歌词搜索歌曲名" placeholder="歌曲名" value={title} onChange={e => setTitle(e.target.value)}/></label><label className="large-search"><input aria-label="歌词搜索歌手" placeholder="歌手（可选）" value={artist} onChange={e => setArtist(e.target.value)}/></label></div>
      <button className="large-primary" type="submit" disabled={!title.trim() || results.isFetching}>{results.isFetching ? <LoaderCircle className="spin"/> : <Search/>}搜索歌词</button>
    </form>
    <LyricMatchActions key={stored?.writeToken} stored={stored} busy={busy} onClear={() => { if (stored) void save(() => clearStoredLyrics(stored)) }}>
      <button className="large-text-button" type="button" role="checkbox" aria-label="同时更新歌名、歌手、专辑和封面" title="同时更新歌名、歌手、专辑和封面" aria-checked={updateMetadata} disabled={busy} onClick={() => setUpdateMetadata(!updateMetadata)}>{updateMetadata ? <Check/> : <span aria-hidden="true">□</span>}同时匹配歌曲信息</button>
    </LyricMatchActions>
    {results.error && <div className="large-error" role="alert"><span>{commandErrorMessage(results.error)}</span><button onClick={() => void results.refetch()}><RefreshCw size={20}/>重试</button></div>}
    {selection.error && <p className="large-error" role="alert">{commandErrorMessage(selection.error)}</p>}{error && <p className="large-error" role="alert">{error}</p>}{results.data?.warning && <p className="large-muted">{results.data.warning}</p>}
    <div className="large-lyric-candidates">{candidates.map(candidate => <button key={`${candidate.provider}:${candidate.id}`} disabled={busy} onClick={() => void choose(candidate)}><span><span className="large-candidate-heading"><strong>{candidate.trackName}</strong><span className="lyric-language-tags">{candidate.romanizedLyrics && <span className="lyric-language-tag romanization" title="含音译">音</span>}{candidate.translatedLyrics && <span className="lyric-language-tag translation" title="含翻译">译</span>}</span></span><small>{candidate.artistName || '歌手未知'} · {candidate.provider === 'netease' ? '网易云' : candidate.provider === 'qq' ? 'QQ音乐' : 'LRCLIB'} · {hasTimedLyrics(candidate.syncedLyrics) ? '逐行' : '文本'}</small></span>{stored?.provider === candidate.provider && stored.providerLyricId === String(candidate.id) && <Check/>}</button>)}</div>
    {results.isSuccess && !candidates.length && <p className="large-empty">没有找到歌词，试试其他歌曲名或歌手</p>}
  </LargeDialog>
}
