import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { Track } from '../../domain/track'
import { lyricsWereCleared, type LyricCandidate, type StoredLyrics } from '../../domain/lyrics'
import { hasTimedLyrics } from '../../domain/lrc'
import { firstSongQuery } from '../../domain/songIdentity'
import { accountEpoch } from '../../services/accountScope'
import { clearStoredLyrics, commandErrorMessage, getStoredLyrics, searchLyrics } from '../../services/desktopApi'
import { rankLyricCandidates } from '../../services/musicMatchRanking'
import { accountQueryKey } from '../../services/queryKeys'
import { isMobile } from '../../services/platform'
import { LyricsChooser } from './LyricsChooser'
import { saveTrackLyrics } from './saveTrackLyrics'

export function TrackLyricsDialog({ track, stored: currentSelection, onClose, onSaved }: {
  track: Track; stored?: StoredLyrics | null; onClose: () => void; onSaved?: (lyrics: StoredLyrics) => void
}) {
  const client = useQueryClient(), epoch = useRef(accountEpoch()).current
  const [title, setTitle] = useState(() => firstSongQuery(track).title)
  const [artist, setArtist] = useState(() => firstSongQuery(track).artist)
  const [manualOpen, setManualOpen] = useState(false), [manualText, setManualText] = useState('')
  const [results, setResults] = useState<LyricCandidate[]>([])
  const [searched, setSearched] = useState(false), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState(''), [searchWarning, setSearchWarning] = useState('')
  const pending = useRef(false), request = useRef(0), alive = useRef(true)
  const snapshot = useQuery({
    queryKey: accountQueryKey('lyric-editor', track.id), queryFn: () => getStoredLyrics(track.id),
    enabled: currentSelection === undefined, staleTime: 0, retry: false,
  })
  const stored = currentSelection !== undefined ? currentSelection : snapshot.data ?? null
  const warning = searchWarning || (stored && !stored.rawText && !lyricsWereCleared(stored)
    ? stored.provider === 'local' ? '请在本机重新导入歌词正文。' : '暂未获取到歌词正文，可重新匹配。' : '')
  const valid = () => alive.current && epoch === accountEpoch()
  const search = async () => {
    const operation = ++request.current
    const applies = () => valid() && request.current === operation
    setLoading(true); setSearched(true); setError(''); setSearchWarning('')
    try {
      const result = await searchLyrics(title.trim(), artist.trim() || undefined, true)
      if (applies()) {
        setResults(rankLyricCandidates(result.candidates, title, artist, track.durationSeconds))
        setSearchWarning(result.warning || '')
      }
    } catch (cause) { if (applies()) setError(commandErrorMessage(cause)) }
    finally { if (applies()) setLoading(false) }
  }
  useEffect(() => {
    alive.current = true
    if (isMobile && title.trim()) void search()
    const leave = () => { ++request.current; onClose() }
    window.addEventListener('bilimusic-account-changing', leave)
    return () => { alive.current = false; ++request.current; window.removeEventListener('bilimusic-account-changing', leave) }
  }, [])

  const save = async (work: () => Promise<StoredLyrics | undefined>) => {
    if (pending.current || !valid()) return
    pending.current = true; ++request.current; setSaving(true); setLoading(false); setError('')
    try {
      const value = await work()
      if (value && valid()) {
        const key = accountQueryKey('lyric-editor', track.id)
        void client.cancelQueries({ queryKey: key, exact: true }, { revert: false })
        client.setQueryData(key, value)
        onSaved?.(value)
        onClose()
      }
    } catch (cause) { if (valid()) setError(commandErrorMessage(cause)) }
    finally { pending.current = false; if (valid()) setSaving(false) }
  }
  const choose = (candidate: LyricCandidate, updateMetadata: boolean) =>
    save(() => saveTrackLyrics(track, candidate, updateMetadata, client, valid))
  const importLyrics = () => {
    const text = manualText.trim()
    if (!text) return Promise.resolve()
    return choose({
      provider: 'local', id: 0, trackName: track.title, artistName: track.artist || '', albumName: track.album || '',
      duration: track.durationSeconds, instrumental: false,
      ...(hasTimedLyrics(text) ? { syncedLyrics: text } : { plainLyrics: text }),
    }, false)
  }
  return <LyricsChooser title={title} artist={artist} onTitle={setTitle} onArtist={setArtist}
    loading={loading} searched={searched} error={error || (snapshot.error ? commandErrorMessage(snapshot.error) : '')}
    warning={warning} candidates={results} stored={stored} saving={saving}
    onSearch={search} onChoose={choose} onClose={() => { if (!pending.current) onClose() }}
    onClear={() => { if (stored) void save(() => clearStoredLyrics(stored)) }}
    manualOpen={manualOpen} onManualOpen={setManualOpen} manualText={manualText} onManualText={setManualText} onImport={importLyrics}/>
}
