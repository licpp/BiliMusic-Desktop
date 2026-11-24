import { listen } from '@tauri-apps/api/event'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { readCollectionProgress, type CollectionProgress } from '../../services/collections'
import { accountQueryKey } from '../../services/queryKeys'
import { isCurrentCollectionResume, type CollectionResumeRequest } from './creatorContinuation'

export function useCollectionProgress(reference: string, enabled = true) {
  const query = useQuery({
    queryKey: accountQueryKey('collection-progress', reference),
    queryFn: () => readCollectionProgress(reference),
    enabled,
    staleTime: 0,
  })
  const { refetch } = query
  useEffect(() => {
    if (!enabled) return
    const seasonPrefix = reference.startsWith('up:') ? `season:${reference.slice(3)}:` : undefined
    const subscription = listen<string>('collection-progress-changed', ({ payload }) => {
      if (payload === reference || (seasonPrefix && payload.startsWith(seasonPrefix))) void refetch()
    }).catch(() => undefined)
    return () => { void subscription.then(stop => stop?.()) }
  }, [enabled, reference, refetch])
  return query
}

const consumed = new WeakSet<CollectionResumeRequest>()
export function useCollectionResumeRequest(request: CollectionResumeRequest | undefined, ready: boolean, attempt: (checkpoint: CollectionProgress) => void | Promise<void>) {
  const run = useRef(attempt)
  run.current = attempt
  useEffect(() => {
    if (!request || !ready) return
    let active = true
    queueMicrotask(() => {
      if (!active || consumed.has(request) || !isCurrentCollectionResume(request)) return
      consumed.add(request)
      void run.current(request.checkpoint)
    })
    return () => { active = false }
  }, [request, ready])
}
