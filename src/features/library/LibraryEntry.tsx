import { CoverBadge } from '../../shared/CoverBadge'
import type { CSSProperties, ReactNode } from 'react'
import { useCollectionDrag } from '../collections/useCollectionDrag'
import { useRowContextMenu, type MenuPosition } from '../../shared/useRowContextMenu'

export function LibraryEntry({ title, titleAdornment, subtitle, cover, coverBadge, coverClassName = '', className = '', style, sidebar = false, active = false, dropFolderId, drag, onOpen, menu }: {
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
  onOpen: () => void
  menu: (position: MenuPosition | undefined) => ReactNode
}) {
  const { position, onContextMenu } = useRowContextMenu()
  const collectionDrag = useCollectionDrag(title, drag)
  const coverClass = sidebar ? 'collection-cover' : 'playlist-card-cover'
  return <div className={`library-entry${sidebar ? ' library-entry-sidebar' : ''} ${className}`} style={style} data-collection-folder={dropFolderId} onContextMenu={onContextMenu}>
    <button type="button" className={sidebar ? `collection-item${active ? ' active' : ''}` : 'playlist-card'} {...collectionDrag.handlers} data-draggable={drag ? '' : undefined} onClick={event => { if (collectionDrag.consumeClick()) { event.preventDefault(); event.stopPropagation() } else onOpen() }} aria-current={active ? 'page' : undefined}>
      <span className={`${coverClass} ${coverClassName}`}>{cover}{coverBadge && <CoverBadge kind={coverBadge}/>}</span>
      <span className="library-entry-copy"><strong>{title}{titleAdornment}</strong>{subtitle && <small>{subtitle}</small>}</span>
    </button>
    {menu(position)}
    {collectionDrag.preview}
  </div>
}
