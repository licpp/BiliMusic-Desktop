import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { accountQueryKey } from '../../services/queryKeys'
import { loadImportedEntries } from '../../services/importedEntries'
import type { Playlist } from '../../domain/library'
import type { ImportedEntry } from '../../domain/importedEntry'

const emptyEntries: ImportedEntry[] = []

export function useImportedPlaylist(playlist?: Playlist) {
  const client = useQueryClient()
  // The prefix only avoids unnecessary reads. Entry provenance, not the prefix,
  // decides whether an individual song can be replaced.
  const enabled = Boolean(playlist?.id.startsWith('import:') && !playlist.isSystem && !playlist.biliFolderId)
  const query = useQuery({
    queryKey: accountQueryKey('imported-entries', playlist?.id),
    queryFn: () => loadImportedEntries(playlist!.id),
    enabled,
    staleTime: 30_000,
  })
  useEffect(() => {
    if (!enabled) return
    const refresh = () => { void client.invalidateQueries({ queryKey: accountQueryKey('imported-entries', playlist?.id) }) }
    window.addEventListener('bilimusic-import-updated', refresh)
    window.addEventListener('bilimusic-library-synced', refresh)
    return () => {
      window.removeEventListener('bilimusic-import-updated', refresh)
      window.removeEventListener('bilimusic-library-synced', refresh)
    }
  }, [enabled, playlist?.id, client])
  const entries = query.data?.entries || emptyEntries
  const byTrack = useMemo(() => new Map(entries.filter(entry => entry.trackId).map(entry => [entry.trackId!, entry])), [entries])
  const missing = useMemo(() => entries.filter(entry => !entry.trackId), [entries])
  return { ...query, entries, byTrack, missing }
}
