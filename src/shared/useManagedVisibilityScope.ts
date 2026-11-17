import { useQuery } from '@tanstack/react-query'
import type { Track } from '../domain/track'
import { canManageVisibility } from '../domain/contentVisibility'
import { listCollections } from '../services/collections'
import { accountQueryKey } from '../services/queryKeys'

export function useManagedVisibilityScope(scope: string | undefined, tracks: readonly Track[], parentScope?: string, owned = false) {
  const saved = useQuery({ queryKey: accountQueryKey('collections'), queryFn: listCollections, enabled: Boolean(scope) && !owned })
  return owned || canManageVisibility(scope, saved.data?.items ?? [], tracks, parentScope) ? scope : undefined
}
