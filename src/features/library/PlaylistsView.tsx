import { useListDataDuringNavigation, useListReveal } from '../../shared/useListMotion'
import { ListSkeleton } from '../../shared/ListSkeleton'
import { useListRows } from '../../shared/useListRows'
import { useRef } from 'react'
import {useListPreferences,playlistEntity} from '../../services/listPreferences'
import {rankList} from '../../services/listOrdering'
import {useOrganizer} from '../../shared/useOrganizer'
import { CreatorsView } from '../collections/CreatorsView'
import { Plus } from 'lucide-react'
import { CollectionsView } from '../collections/CollectionsView'
import type { Playlist } from '../../domain/library'
import type { Collection } from '../../services/collections'
import { SwipeTabPages } from '../../shared/SwipeTabPages'
import { PlaylistEntry } from './PlaylistEntry'
import { ImportPlaylistButton } from './ImportFavorites'

const tabs = [{ id: 'playlists', label: '歌单' }, { id: 'collections', label: '收藏' }, { id: 'creators', label: '关注' }] as const

export function PlaylistsView({ playlists, loading, onOpen, onRemoved, onCreate, onImport, onCollectionOpen, onOpenFolder, onOpenCreatorFolder, section, onSectionChange }: {
  playlists: Playlist[]
  loading?: boolean
  onOpen: (id: string) => void
  onRemoved: (id: string) => void
  onCreate: () => void
  onImport: () => void
  onCollectionOpen: (item: Collection) => void
  onOpenFolder: (id: string) => void
  onOpenCreatorFolder: (id: string) => void
  section: 'playlists' | 'collections' | 'creators'
  onSectionChange: (section: 'playlists' | 'collections' | 'creators') => void
}) {
  const preferences=useListPreferences()
  const visible = useListDataDuringNavigation(loading ? undefined : playlists, 'playlists')
  const ordered=rankList(visible || [],preferences.data?.preferences||[],playlistEntity)
  const organizer=useOrganizer(ordered.map(item=>({id:playlistEntity(item),name:item.name,coverUrl:item.coverUrl,kind:item.biliFolderId?'linked' as const:'playlist' as const})), '整理歌单')
  return <section className="playlists-view listening-library">
    <SwipeTabPages tabs={tabs} value={section} onChange={onSectionChange} idPrefix="hub" panelId="listening-panel"
      label="个人音乐收藏" className="listening-tabs" renderPanel={(pane, active) =>
      pane === 'playlists' ? <>
        <div className="listening-tools hub-list-toolbar">
          <span className="hub-summary">{visible && `${visible.length} 个歌单`}</span>
          <div className="hub-toolbar-actions library-action-rail">{organizer.controls}
          {!organizer.editing && <><button type="button" className="collection-icon library-create-action" aria-label="新建歌单" onClick={onCreate}><Plus size={18}/></button>
          <ImportPlaylistButton onClick={onImport}/></>}</div>
        </div>
        {organizer.editing ? organizer.editor : <PlaylistGrid playlists={ordered} active={active} loading={!visible} onOpen={onOpen} onRemoved={onRemoved}/>}
      </> : pane === 'creators' ? <CreatorsView followed onOpen={onCollectionOpen} onOpenFolder={onOpenCreatorFolder}/> : <CollectionsView hideHeading onOpenFolder={onOpenFolder} onOpenLinked={onOpen} onLinkedRemoved={onRemoved} onSelect={onCollectionOpen}/>} />
  </section>
}

function PlaylistGrid({ playlists, loading, active, onOpen, onRemoved }: {
  playlists: Playlist[]; loading: boolean; active: boolean
  onOpen: (id: string) => void; onRemoved: (id: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const rendered = useListRows(playlists, 'playlists', { active })
  useListReveal(root, loading, playlists.length > 0, active)
  return loading ? <ListSkeleton label="正在读取歌单"/> : <div ref={root} className="playlist-grid library-gallery">
    {rendered.rows.map(playlist => <PlaylistEntry gallery key={playlist.id} playlist={playlist} onOpen={() => onOpen(playlist.id)} onRemoved={() => onRemoved(playlist.id)}/>)}
    {rendered.more && <div ref={rendered.tail} className="list-render-tail" aria-hidden="true"/>}
  </div>
}
