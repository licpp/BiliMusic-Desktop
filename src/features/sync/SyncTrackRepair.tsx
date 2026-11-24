import { CollectionDialog } from '../../shared/CollectionDialog'
import type { TrackRepairPreview } from '../../services/sync'

const kinds = { favorite: '已收藏', playlist: '歌单', history: '最近播放' } as const

export function SyncTrackRepair({ preview, onClose, onArchive }: {
  preview: TrackRepairPreview
  onClose: () => void
  onArchive: (revision: string) => void
}) {
  return <CollectionDialog title="修复同步记录" className="sync-track-repair" mobileSheet onClose={onClose}>
    <p>有 {preview.total} 条本机记录找不到对应的歌曲。确认后将备份并移除这些记录。</p>
    <ul className="sync-track-repair-list">
      {preview.entries.map(({ kind, label, trackId }, index) => <li key={`${kind}:${trackId}:${index}`}>
        <strong>{kinds[kind]}{kind === 'playlist' && label ? ` · ${label}` : ''}</strong>
        <small>{trackId || '缺少歌曲编号'}{kind !== 'playlist' && label ? ` · ${label}` : ''}</small>
      </li>)}
    </ul>
    {preview.total > preview.entries.length && <p>还有 {preview.total - preview.entries.length} 条记录将一并备份。</p>}
    <footer>
      <button type="button" className="collection-flat-button" data-dialog-autofocus onClick={onClose}>取消</button>
      <button type="button" className="collection-flat-button action-danger" onClick={() => onArchive(preview.revision)}>备份并移除</button>
    </footer>
  </CollectionDialog>
}
