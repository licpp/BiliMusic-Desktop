import { Download, Plus } from 'lucide-react'
import { CollectionsView } from '../collections/CollectionsView'
import type { Playlist } from '../../services/desktopApi'
import type { Collection } from '../../services/collections'
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
  section: 'playlists' | 'collections'
  onSectionChange: (section: 'playlists' | 'collections') => void
}) {
  return <section className="playlists-view listening-library">
    <div className="listening-tabs" role="tablist" aria-label="个人音乐收藏" onKeyDown={event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 'playlists' : event.key === 'End' ? 'collections' : section === 'playlists' ? 'collections' : 'playlists'
      onSectionChange(next)
      document.getElementById(`hub-${next}`)?.focus()
    }}>
      <button id="hub-playlists" role="tab" tabIndex={section === 'playlists' ? 0 : -1} aria-selected={section === 'playlists'} aria-controls="listening-panel" onClick={() => onSectionChange('playlists')}>歌单<small>{playlists.length}</small></button>
      <button id="hub-collections" role="tab" tabIndex={section === 'collections' ? 0 : -1} aria-selected={section === 'collections'} aria-controls="listening-panel" onClick={() => onSectionChange('collections')}>收藏</button>
    </div>
    <div id="listening-panel" role="tabpanel" aria-labelledby={`hub-${section}`}>
      {section === 'playlists' ? <>
        <div className="listening-tools">
          <span>我的歌单</span>
          <button type="button" className="collection-icon" aria-label="新建歌单" onClick={onCreate}><Plus size={18}/></button>
          <button type="button" className="collection-icon" aria-label="导入 B 站收藏夹" onClick={onImport}><Download size={18}/></button>
        </div>
        <div className="playlist-grid">{playlists.map(playlist => <PlaylistEntry key={playlist.id} playlist={playlist} onOpen={() => onOpen(playlist.id)} onRemoved={() => onRemoved(playlist.id)}/>)}</div>
      </> : <CollectionsView linkedFolders={linkedFolders} onOpenFolder={onOpenFolder} onOpenLinked={onOpen} onLinkedRemoved={onRemoved} onSelect={onCollectionOpen}/>}
    </div>
  </section>
}
