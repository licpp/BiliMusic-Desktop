import { useEffect, useRef, useState } from 'react'
import type { Track } from '../../domain/track'
import type { LyricLine, StoredLyrics } from '../../domain/lyrics'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage, setStoredLyricsBias } from '../../services/desktopApi'
import { usePlayerStore } from '../player/playerStore'
import { automaticLyricBias } from './autoAlignment'

type Options = {
  track: Track | null; stored: StoredLyrics | null | undefined; lines: readonly LyricLine[]; enabled: boolean
  beforeAlign?: () => Promise<void>; onAligned: (saved: StoredLyrics) => void
}
export function useAutoLyricAlignment(options: Options) {
  const latest = useRef(options); latest.current = options
  const generation = useRef(0), mounted = useRef(false), running = useRef(false)
  const [state, setState] = useState({ busy: false, message: '', failed: false })
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++; running.current = false }
  }, [])
  useEffect(() => {
    generation.current++; running.current = false; setState({ busy: false, message: '', failed: false })
  }, [options.enabled, options.track?.id, options.stored?.writeToken])
  const run = async () => {
    const { track, stored, lines, enabled, beforeAlign, onAligned } = latest.current
    if (!enabled || !track || !stored || stored.trackId !== track.id || running.current || usePlayerStore.getState().current?.id !== track.id) return
    running.current = true
    const operation = ++generation.current, epoch = accountEpoch(), playback = usePlayerStore.getState().current
    const valid = () => mounted.current && operation === generation.current && epoch === accountEpoch()
      && latest.current.enabled && latest.current.stored === stored && usePlayerStore.getState().current === playback
    setState({ busy: true, message: '', failed: false })
    try {
      await beforeAlign?.()
      if (!valid()) return
      const result = await automaticLyricBias(track.source, lines, valid)
      if (!result || !valid()) return
      const saved = await setStoredLyricsBias(track.id, result.biasMs, stored)
      if (!valid()) return
      onAligned(saved)
      window.dispatchEvent(new CustomEvent('bilimusic-lyrics-updated', { detail: saved }))
      setState({ busy: false, message: '歌词已自动对齐', failed: false })
    } catch (error) {
      if (valid()) setState({ busy: false, message: commandErrorMessage(error), failed: true })
    } finally {
      if (mounted.current && operation === generation.current) { running.current = false; setState(value => ({ ...value, busy: false })) }
    }
  }
  return { ...state, run }
}
