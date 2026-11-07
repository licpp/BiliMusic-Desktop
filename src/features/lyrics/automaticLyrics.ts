import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { getStoredLyrics, inDesktopShell, saveStoredLyrics, searchLyrics, type LyricCandidate } from '../../services/desktopApi'
import { usePlayerStore } from '../player/playerStore'
import { bestCandidate, candidateLines } from './lrc'

export function automaticLyricQuery(track: Track) {
  let title = track.title.replace(/^\s*(?:P\s*)?\d+[.、．\s]+/i, '').trim()
  let artist = track.artist?.trim() || ''
  const pair = title.match(/^(.{1,40}?)\s*[-–—]\s*(.+)$/)
  if (pair && (!artist || pair[1].trim() === artist)) {
    artist ||= pair[1].trim()
    title = pair[2].trim()
  }
  title = title.replace(/【[^】]*】/g, '').replace(/\s*[（(](?:live|现场|完整版|歌词版|高清|无损)[^）)]*[）)]/gi, '').trim()
  return { title, artist }
}

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
export function chooseAutomaticLyrics(track: Track, candidates: LyricCandidate[]) {
  const query = automaticLyricQuery(track)
  return bestCandidate(candidates.filter(candidate => {
    if (candidate.instrumental || normalize(candidate.trackName) !== normalize(query.title)) return false
    if (query.artist && !normalize(candidate.artistName).includes(normalize(query.artist))) return false
    return !track.durationSeconds || !candidate.duration || Math.abs(track.durationSeconds - candidate.duration) <= Math.max(15, track.durationSeconds * .08)
  }), track.durationSeconds)
}

export function startAutomaticLyrics() {
  if (!inDesktopShell) return
  const attempted = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduled = ''
  const keyFor = (track: Track) => `${accountEpoch()}:${JSON.stringify([track.id, track.title, track.artist, track.durationSeconds])}`
  const run = async (track: Track, key: string) => {
    const valid = () => { const current = usePlayerStore.getState().current; return current !== null && keyFor(current) === key }
    try {
      if (await getStoredLyrics(track.id) || !valid()) return
      const query = automaticLyricQuery(track)
      if (!query.title) return
      const result = await searchLyrics(query.title, query.artist || undefined)
      if (!valid()) return
      const candidate = chooseAutomaticLyrics(track, result.candidates)
      if (!candidate || !candidateLines(candidate).length) return
      // Recheck after the network request: a manual selection may have won.
      if (await getStoredLyrics(track.id) || !valid()) return
      const saved = await saveStoredLyrics(track.id, candidate, candidateLines(candidate), false)
      if (valid()) window.dispatchEvent(new CustomEvent('bilimusic-lyrics-updated', { detail: saved }))
    } catch { /* Automatic lookup must never interrupt playback or show an error dialog. */ }
  }
  const schedule = () => {
    const state = usePlayerStore.getState()
    const key = state.current && state.status === 'playing' ? keyFor(state.current) : ''
    if (key === scheduled) return
    scheduled = key; clearTimeout(timer)
    if (!key || !state.current || Date.now() - (attempted.get(key) || 0) < 120_000) return
    const track = state.current
    timer = setTimeout(() => {
      attempted.set(key, Date.now())
      if (attempted.size > 100) attempted.delete(attempted.keys().next().value!)
      void run(track, key)
    }, 600)
  }
  const unsubscribe = usePlayerStore.subscribe(schedule)
  schedule()
  return () => { clearTimeout(timer); unsubscribe() }
}
