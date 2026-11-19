import { useMatchMetadataPreference } from '../features/lyrics/useMatchMetadataPreference'
import { accountKeyAt } from '../services/queryKeys'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, LoaderCircle, Search } from 'lucide-react'
import type { Track } from '../domain/track'
import { accountEpoch } from '../services/accountScope'
import { commandErrorMessage, searchLyrics, saveStoredLyrics, lyricMatchVersion, saveLyricsWithMetadata } from '../services/desktopApi'
import { metadataForLyric } from '../services/batchMatching'
import { usePlayerStore } from '../features/player/playerStore'
import type { LyricCandidate, StoredLyrics } from '../domain/lyrics'
import { candidateLines } from '../domain/lrc'
import { firstSongQuery } from '../domain/songIdentity'
import { rankLyricCandidates } from '../services/musicMatchRanking'
import { LargeDialog } from './LargeDialog'
import { Failure } from './Library'

export function LargeLyricSearch({ track, stored, onSaved, onClose }: { track: Track; stored?: StoredLyrics | null; onSaved: (value: StoredLyrics) => void; onClose: () => void }) {
  const initial = firstSongQuery(track), epoch = accountEpoch()
  const [title, setTitle] = useState(initial.title), [artist, setArtist] = useState(initial.artist)
  const [submitted, setSubmitted] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [updateMetadata, setUpdateMetadata] = useMatchMetadataPreference()
  const client = useQueryClient()
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const results = useQuery({ queryKey: accountKeyAt(epoch, 'large-lyric-search', submitted.title, submitted.artist), queryFn: () => searchLyrics(submitted.title, submitted.artist || undefined, true), enabled: Boolean(submitted.title.trim()), retry: false })
  const candidates = rankLyricCandidates(results.data?.candidates || [], submitted.title, submitted.artist, track.durationSeconds)
  async function choose(candidate: LyricCandidate) {
    if (busy) return
    const lines = candidateLines(candidate)
    if (!lines.length) { setError('这个版本没有可显示的歌词'); return }
    setBusy(true); setError('')
    try {
      let value
      if (updateMetadata) {
        const version = await lyricMatchVersion(track.id)
        const metadata = await metadataForLyric(candidate)
        if (!alive.current || epoch !== accountEpoch()) return
        const pair = await saveLyricsWithMetadata(track.id, candidate, lines, metadata, version)
        if (epoch !== accountEpoch()) return
        usePlayerStore.getState().updateTrack(pair.track)
        void client.invalidateQueries({ predicate: q => /library|playlist|recent/.test(String(q.queryKey[0])) })
        value = pair.stored
      } else value = await saveStoredLyrics(track.id, candidate, lines, true)
      if (alive.current && epoch === accountEpoch()) { onSaved(value); onClose() }
    }
    catch (e) { if (alive.current && epoch === accountEpoch()) setError(commandErrorMessage(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <LargeDialog title="匹配歌词" className="large-lyric-search" onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); const next = { title: title.trim(), artist: artist.trim() }; if (!next.title) return; setError(''); if (next.title === submitted.title && next.artist === submitted.artist) void results.refetch(); else setSubmitted(next) }}>
      <div className="large-lyric-fields"><label className="large-search"><input data-primary-focus aria-label="歌词搜索歌曲名" placeholder="歌曲名" value={title} onChange={e => setTitle(e.target.value)}/></label><label className="large-search"><input aria-label="歌词搜索歌手" placeholder="歌手（可选）" value={artist} onChange={e => setArtist(e.target.value)}/></label></div>
      <button className="large-primary" type="submit" disabled={!title.trim() || results.isFetching}>{results.isFetching ? <LoaderCircle className="spin"/> : <Search/>}搜索歌词</button>
    </form>
    <button className="large-text-button" type="button" role="checkbox" aria-checked={updateMetadata} disabled={busy} onClick={() => setUpdateMetadata(!updateMetadata)}>{updateMetadata ? <Check/> : <span aria-hidden="true">□</span>}同时更新歌名、歌手、专辑和封面</button>
    <Failure error={results.error} retry={() => void results.refetch()}/>{error && <p className="large-error" role="alert">{error}</p>}{results.data?.warning && <p className="large-muted">{results.data.warning}</p>}
    <div className="large-lyric-candidates">{candidates.map(candidate => <button key={`${candidate.provider}:${candidate.id}`} disabled={busy} onClick={() => void choose(candidate)}><span><span className="large-candidate-heading"><strong>{candidate.trackName}</strong><span className="lyric-language-tags">{candidate.romanizedLyrics && <span className="lyric-language-tag romanization" title="含音译">音</span>}{candidate.translatedLyrics && <span className="lyric-language-tag translation" title="含翻译">译</span>}</span></span><small>{candidate.artistName || '歌手未知'} · {candidate.provider === 'netease' ? '网易云' : candidate.provider === 'qq' ? 'QQ音乐' : 'LRCLIB'} · {candidate.syncedLyrics ? '动态歌词' : '文本歌词'}</small></span>{stored?.provider === candidate.provider && stored.providerLyricId === String(candidate.id) && <Check/>}</button>)}</div>
    {results.isSuccess && !candidates.length && <p className="large-empty">没有找到歌词，试试其他歌曲名或歌手</p>}
  </LargeDialog>
}
