import type { ReactNode } from 'react'
import { useRowContextMenu, type MenuPosition } from '../../shared/useRowContextMenu'

export function LibraryEntry({ title, subtitle, cover, coverClassName = '', sidebar = false, active = false, dropFolderId, leading, onOpen, menu }: {
  title: string
  subtitle: string
  cover: ReactNode
  coverClassName?: string
  sidebar?: boolean
  active?: boolean
  dropFolderId?: string
  leading?: ReactNode
  onOpen: () => void
  menu: (position: MenuPosition | undefined) => ReactNode
}) {
  const { position, onContextMenu } = useRowContextMenu()
  const coverClass = sidebar ? 'collection-cover' : 'playlist-card-cover'
  return <div className={`library-entry${sidebar ? ' library-entry-sidebar' : ''}`} data-collection-folder={dropFolderId} onContextMenu={onContextMenu}>
    {leading}
    <button type="button" className={sidebar ? `collection-item${active ? ' active' : ''}` : 'playlist-card'} onClick={onOpen} aria-current={active ? 'page' : undefined}>
      <span className={`${coverClass} ${coverClassName}`}>{cover}</span>
      <span className="library-entry-copy"><strong>{title}</strong><small>{subtitle}</small></span>
    </button>
    {menu(position)}
  </div>
}
