import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { getStoredLyrics, inDesktopShell, saveStoredLyrics, searchLyrics } from '../../services/desktopApi'
import type { LyricCandidate } from '../../domain/lyrics'
import { usePlayerStore } from '../player/playerStore'
import { candidateLines } from '../../domain/lrc'

import { songQueries } from '../../domain/songIdentity'

export { chooseAutomaticLyrics } from '../../domain/automaticLyrics'
import { chooseAutomaticLyrics } from '../../domain/automaticLyrics'

export function startAutomaticLyrics() {
  if (!inDesktopShell) return
  let active = true
  const attempted = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduled = ''
  const keyFor = (track: Track) => `${accountEpoch()}:${JSON.stringify([track.id, track.title, track.artist, track.source?.uploaderName, track.durationSeconds])}`
  const run = async (track: Track, key: string) => {
    const valid = () => { const current = usePlayerStore.getState().current; return active && current !== null && keyFor(current) === key }
    try {
      if (await getStoredLyrics(track.id) || !valid()) return
      let candidate: LyricCandidate | undefined
      for (const query of songQueries(track)) {
        if (!query.title || !valid()) return
        try {
          const result = await searchLyrics(query.title, query.artist || undefined)
          if (!valid()) return
          candidate = chooseAutomaticLyrics(track, result.candidates, query)
          if (candidate) break
        } catch { if (!valid()) return }
      }
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
  return () => { active = false; clearTimeout(timer); unsubscribe() }
}
