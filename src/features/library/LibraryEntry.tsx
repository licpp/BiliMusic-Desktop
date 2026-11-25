import { CoverBadge } from '../../shared/CoverBadge'
import type { CSSProperties, ReactNode } from 'react'
import { useCollectionDrag } from '../collections/useCollectionDrag'
import { useRowContextMenu, type MenuPosition } from '../../shared/useRowContextMenu'
import type { Organizer } from '../../shared/useOrganizer'

export function LibraryEntry({ title, titleAdornment, subtitle, cover, coverBadge, coverClassName = '', className = '', style, sidebar = false, active = false, dropFolderId, drag, order, onOpen, menu }: {
  style?: CSSProperties
  className?: string
  title: string
  titleAdornment?: ReactNode
  subtitle: string
  coverBadge?: 'folder' | 'linked'
  cover: ReactNode
  coverClassName?: string
  sidebar?: boolean
  active?: boolean
  dropFolderId?: string
  drag?: { folderId: string; onMove: (folderId: string) => void }
  order?: { organizer: Organizer; id: string }
  onOpen: () => void
  menu: (position: MenuPosition | undefined) => ReactNode
}) {
  const { position, onContextMenu } = useRowContextMenu()
  const handle = order?.organizer.handle(order.id)
  const collectionDrag = useCollectionDrag(title, handle ? undefined : drag)
  const coverClass = sidebar ? 'collection-cover' : 'playlist-card-cover'
  return <div className={`library-entry${sidebar ? ' library-entry-sidebar' : ''} ${className}`} style={style} {...order?.organizer.rowProps(order.id)} data-collection-folder={dropFolderId} onContextMenu={handle ? undefined : onContextMenu}>
    <button type="button" className={sidebar ? `collection-item${active ? ' active' : ''}` : 'playlist-card'} {...collectionDrag.handlers} data-draggable={drag && !handle ? '' : undefined} aria-disabled={handle ? true : undefined} onClick={event => { if (collectionDrag.consumeClick() || handle) { event.preventDefault(); event.stopPropagation() } else onOpen() }} aria-current={active ? 'page' : undefined}>
      <span className={`${coverClass} ${coverClassName}`}>{cover}{coverBadge && <CoverBadge kind={coverBadge}/>}</span>
      <span className="library-entry-copy"><strong>{title}{titleAdornment}</strong>{subtitle && <small>{subtitle}</small>}</span>
    </button>
    {handle ?? menu(position)}
    {collectionDrag.preview}
  </div>
}
