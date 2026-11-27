import { useLayoutEffect, useRef, useState } from 'react'
import { playbackIntent, usePlayerStore, type QueueSource } from '../features/player/playerStore'
import type { Track } from '../domain/track'
import { accountEpoch } from '../services/accountScope'
import type { Collection } from '../services/collections'
import { getVideoParts } from '../services/videoPages'
import type { Navigate } from './Library'
import { collectionContext } from './playbackContext'
import { resolveLargeVideoEntry } from './videoEntry'

type Selection = {
  parentRef?: string
  row?: Track
  queue?: Track[]
  source?: QueueSource
  applyOverrides?: (track: Track) => Track
}

export function useVideoEntry(navigate: Navigate, scope: string) {
  const request = useRef(0)
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<unknown>()
  useLayoutEffect(() => {
    setPending(undefined)
    setError(undefined)
    return () => { request.current++ }
  }, [scope])

  async function open(item: Collection, { parentRef, row, queue, source, applyOverrides }: Selection = {}) {
    const selection = ++request.current, epoch = accountEpoch(), intent = playbackIntent()
    const active = () => request.current === selection && accountEpoch() === epoch
    const current = () => active() && playbackIntent() === intent
    setPending(item.bvid)
    setError(undefined)
    try {
      const entry = await resolveLargeVideoEntry(() => getVideoParts(item.bvid), row)
      if (!current()) return
      if (entry.kind === 'parts') {
        navigate({ kind: 'collection', item, parentRef })
        return
      }
      const track = applyOverrides?.(entry.track) ?? entry.track
      const tracks = row && queue ? queue.map(candidate => candidate.id === row.id ? track : candidate) : [track]
      const context = source ?? { ...collectionContext(item.title || track.title, item.bvid, false, 1),
        ...(parentRef && { collectionRef: parentRef }) }
      await usePlayerStore.getState().playFromList(tracks, track.id, context)
    } catch (cause) {
      if (current()) setError(cause)
    } finally {
      if (active()) setPending(undefined)
    }
  }

  return { open, pending, error }
}
