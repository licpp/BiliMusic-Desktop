import { useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Track } from '../../domain/track'
import { loadImportedEntries } from '../../services/importedEntries'
import { accountQueryKey } from '../../services/queryKeys'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { ReplacementSearch } from './ReplacementDialog'

/** A queue snapshot isn't a write revision: re-read the canonical binding. */
export function PlayingVideoReplacement({ track, renderDialog, onClose }: { track: Track; renderDialog?: (body: ReactNode) => ReactNode; onClose: () => void }) {
  useEffect(() => {
    window.addEventListener('bilimusic-account-changing', onClose)
    return () => window.removeEventListener('bilimusic-account-changing', onClose)
  }, [onClose])
  const wrap = (body: ReactNode) => renderDialog ? renderDialog(body) : <CollectionDialog title="更换视频" mobileSheet className="import-match-dialog" onClose={onClose}>{body}</CollectionDialog>
  const client = useQueryClient(), playlistId = track.importedEntry?.playlistId || ''
  const query = useQuery({ queryKey: accountQueryKey('imported-entries', playlistId), queryFn: () => loadImportedEntries(playlistId), enabled: Boolean(playlistId), staleTime: 0 })
  const entry = query.data?.entries.find(e => e.entryId === track.importedEntry?.entryId && e.trackId === track.id)
  if (!query.data || !entry) {
    const body = <p role="status">{query.isPending ? '正在读取…' : '歌曲来源已变化，请重新打开'}</p>
    return wrap(body)
  }
  const props = { entry, session: query.data.session, currentTrack: track, onClose, onSaved: () => {
    for (const key of ['library','playlists','imported-entries']) void client.invalidateQueries({ queryKey: accountQueryKey(key) })
    onClose()
  } }
  return wrap(<ReplacementSearch {...props}/>)
}
