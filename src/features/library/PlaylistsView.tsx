import { CollectionsView } from '../collections/CollectionsView'
import { Album, Heart, Plus, Download } from 'lucide-react'
import type { Playlist } from '../../services/desktopApi'
import { Artwork } from '../../shared/Artwork'
export function PlaylistsView({ playlists, onOpen, onCreate, onImport }: { playlists:Playlist[]; onOpen:(id:string)=>void; onCreate:()=>void; onImport:()=>void }) {
  return <section className="playlists-view"><header><span className="eyebrow">YOUR PLAYLISTS</span><h2>我的歌单</h2><p>把喜欢的声音，整理成自己的日常。</p></header><div className="collection-actions"><button onClick={onCreate}><Plus size={16} />新建歌单</button><button onClick={onImport}><Download size={16} />导入B站收藏夹</button></div><div className="playlist-grid">{playlists.map(p=><button className="playlist-card" key={p.id} onClick={()=>onOpen(p.id)}><span className={p.isSystem ? 'playlist-card-cover favorites-cover' : 'playlist-card-cover'}>{p.coverUrl ? <Artwork src={p.coverUrl} /> : p.isSystem ? <Heart fill="currentColor" /> : <Album />}</span><span><strong>{p.name}</strong><small>{p.trackCount} 首{p.isSystem ? ' · 默认歌单' : ''}</small></span></button>)}</div><CollectionsView /></section>
}
