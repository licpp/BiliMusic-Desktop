import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Sparkles, Square } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { Track } from '../../domain/track'
import { matchTracksAutomatically, type BatchMatchProgress } from '../../services/batchMatching'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage } from '../../services/userErrors'
import { accountQueryKey } from '../../services/queryKeys'
import { usePlayerStore } from '../player/playerStore'

function useBatchMatch(tracks: Track[], onMatched?: (ids: ReadonlySet<string>) => void) {
  const client = useQueryClient()
  const abort = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<BatchMatchProgress>()
  const [message, setMessage] = useState('')
  useEffect(() => {
    const reset = () => {
      abort.current?.abort()
      abort.current = null
      setBusy(false)
      setState(undefined)
      setMessage('')
    }
    window.addEventListener('bilimusic-account-changing', reset)
    return () => {
      abort.current?.abort()
      window.removeEventListener('bilimusic-account-changing', reset)
    }
  }, [])
  const run = async () => {
    if (abort.current || !tracks.length) return
    const controller = new AbortController()
    const epoch = accountEpoch()
    const current = () => epoch === accountEpoch() && !controller.signal.aborted
    abort.current = controller
    setBusy(true)
    setState(undefined)
    setMessage('')
    const matched = new Set<string>()
    try {
      await matchTracksAutomatically(tracks, controller.signal, setState, track => {
        if (current()) {
          matched.add(track.id)
          usePlayerStore.getState().updateTrack(track)
        }
      })
    } catch (cause) {
      if (current()) setMessage(commandErrorMessage(cause))
    } finally {
      if (abort.current === controller) {
        abort.current = null
        if (epoch === accountEpoch()) {
          setBusy(false)
          void client.invalidateQueries({ queryKey: accountQueryKey('library') })
          void client.invalidateQueries({ queryKey: accountQueryKey('playlists') })
          if (matched.size) onMatched?.(matched)
        }
      }
    }
  }
  const feedback = busy
    ? state ? `匹配中 ${state.done}/${state.total}` : '正在读取所选歌曲…'
    : [
        state && `已匹配 ${state.matched}`,
        state?.protected && `保留已有 ${state.protected}`,
        state?.unmatched && `未找到 ${state.unmatched}`,
        state?.conflicts && `期间已更新 ${state.conflicts}`,
        state?.failed && `请求失败 ${state.failed}`,
        message,
      ].filter(Boolean).join(' · ')
  return { busy, feedback, run, stop: () => abort.current?.abort() }
}

export function BatchMatchButton({ tracks, onMatched }: { tracks: Track[]; onMatched?: (ids: ReadonlySet<string>) => void }) {
  const matching = useBatchMatch(tracks, onMatched)
  return <span className="batch-match-control">
    <button type="button" disabled={!matching.busy && !tracks.length} onClick={matching.busy ? matching.stop : () => void matching.run()} title="同时匹配歌曲信息与歌词">
      {matching.busy ? <Square size={16}/> : <Sparkles size={16}/>}<span>{matching.busy ? '停止匹配' : '自动匹配'}</span>
    </button>
    {matching.feedback && <span className="batch-match-progress" role="status">
      {matching.busy && <LoaderCircle size={13} className="spin"/>}{matching.feedback}
    </span>}
  </span>
}
