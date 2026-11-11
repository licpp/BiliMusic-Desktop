import { CreatorsView } from '../collections/CreatorsView'
import { Download, Plus } from 'lucide-react'
import { CollectionsView } from '../collections/CollectionsView'
import type { Playlist } from '../../services/desktopApi'
import type { Collection } from '../../services/collections'
import { SegmentedTabs } from '../../shared/SegmentedTabs'
import { useSwipeTabs } from '../../shared/useSwipeTabs'
import { PlaylistEntry } from './PlaylistEntry'

export function PlaylistsView({ playlists, linkedFolders, onOpen, onRemoved, onCreate, onImport, onCollectionOpen, onOpenFolder, section, onSectionChange }: {
  playlists: Playlist[]
  linkedFolders: Playlist[]
  onOpen: (id: string) => void
  onRemoved: (id: string) => void
  onCreate: () => void
  onImport: () => void
  onCollectionOpen: (item: Collection) => void
  onOpenFolder: (id: string) => void
  section: 'playlists' | 'collections' | 'creators'
  onSectionChange: (section: 'playlists' | 'collections' | 'creators') => void
}) {
  const swipe = useSwipeTabs(['playlists', 'collections', 'creators'], section, onSectionChange)
  return <section className="playlists-view listening-library">
    <SegmentedTabs tabs={[{ id: 'playlists', label: '歌单' }, { id: 'collections', label: '收藏' }, { id: 'creators', label: '关注' }]}
      value={section} onChange={onSectionChange} idPrefix="hub" panelId="listening-panel" label="个人音乐收藏" className="listening-tabs"/>
    <div id="listening-panel" ref={swipe} data-swipe-tabs role="tabpanel" aria-labelledby={`hub-${section}`}>
      <div className="segmented-panel" key={section}>
      {section === 'playlists' ? <>
        <div className="listening-tools">
          <button type="button" className="collection-icon" aria-label="新建歌单" onClick={onCreate}><Plus size={18}/></button>
          <button type="button" className="collection-icon" aria-label="导入 B 站收藏夹" onClick={onImport}><Download size={18}/></button>
        </div>
        <div className="playlist-grid">{playlists.map(playlist => <PlaylistEntry key={playlist.id} playlist={playlist} onOpen={() => onOpen(playlist.id)} onRemoved={() => onRemoved(playlist.id)}/>)}</div>
      </> : section === 'creators' ? <CreatorsView followed onOpen={onCollectionOpen}/> : <CollectionsView hideHeading linkedFolders={linkedFolders} onOpenFolder={onOpenFolder} onOpenLinked={onOpen} onLinkedRemoved={onRemoved} onSelect={onCollectionOpen}/>}
      </div>
    </div>
  </section>
}
