import {useListPreferences,playlistEntity} from '../../services/listPreferences'
import {rankList} from '../../services/listOrdering'
import {useOrganizer} from '../../shared/useOrganizer'
import { CreatorsView } from '../collections/CreatorsView'
import { Plus } from 'lucide-react'
import { CollectionsView } from '../collections/CollectionsView'
import type { Playlist } from '../../services/desktopApi'
import type { Collection } from '../../services/collections'
import { SegmentedTabs } from '../../shared/SegmentedTabs'
import { useSwipeTabs } from '../../shared/useSwipeTabs'
import { PlaylistEntry } from './PlaylistEntry'
import { ImportPlaylistButton } from './ImportFavorites'

export function PlaylistsView({ playlists, onOpen, onRemoved, onCreate, onImport, onCollectionOpen, onOpenFolder, onOpenCreatorFolder, section, onSectionChange }: {
  playlists: Playlist[]
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
  const ordered=rankList(playlists,preferences.data?.preferences||[],playlistEntity)
  const organizer=useOrganizer(ordered.map(item=>({id:playlistEntity(item),name:item.name,coverUrl:item.coverUrl,kind:item.biliFolderId?'linked' as const:'playlist' as const})), '整理歌单')
  const swipe = useSwipeTabs(['playlists', 'collections', 'creators'], section, onSectionChange)
  return <section className="playlists-view listening-library">
    <SegmentedTabs tabs={[{ id: 'playlists', label: '歌单' }, { id: 'collections', label: '收藏' }, { id: 'creators', label: '关注' }]}
      value={section} onChange={onSectionChange} idPrefix="hub" panelId="listening-panel" label="个人音乐收藏" className="listening-tabs"/>
    <div id="listening-panel" ref={swipe} data-swipe-tabs role="tabpanel" aria-labelledby={`hub-${section}`}>
      <div className="segmented-panel" key={section}>
      {section === 'playlists' ? <>
        <div className="listening-tools hub-list-toolbar">
          <span className="hub-summary">{playlists.length} 个歌单</span>
          <div className="hub-toolbar-actions"><button type="button" className="collection-icon" aria-label="新建歌单" onClick={onCreate}><Plus size={18}/></button>
          <ImportPlaylistButton onClick={onImport}/>{organizer.controls}</div>
        </div>
        {organizer.editing?organizer.editor:<div className="playlist-grid">{ordered.map(playlist => <PlaylistEntry key={playlist.id} playlist={playlist} onOpen={() => onOpen(playlist.id)} onRemoved={() => onRemoved(playlist.id)}/>)}</div>}
      </> : section === 'creators' ? <CreatorsView followed onOpen={onCollectionOpen} onOpenFolder={onOpenCreatorFolder}/> : <CollectionsView hideHeading onOpenFolder={onOpenFolder} onOpenLinked={onOpen} onLinkedRemoved={onRemoved} onSelect={onCollectionOpen}/>}
      </div>
    </div>
  </section>
}
