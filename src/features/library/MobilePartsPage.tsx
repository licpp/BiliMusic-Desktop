import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { BiliVideoParts } from '../../services/desktopApi'
import { toTrack } from '../../services/collectionTrack'
import { MobilePage } from '../../shared/MobilePage'
import { Artwork } from '../../shared/Artwork'
import { VideoPartsList } from './VideoPartsList'

export function MobilePartsPage({ detail, onBack }: { detail: BiliVideoParts; onBack: () => void }) {
  const [query, setQuery] = useState('')
  const tracks = useMemo(() => detail.parts.map(part => toTrack(detail, part)), [detail])
  const needle = query.trim().toLocaleLowerCase()
  const visible = needle ? tracks.filter(track => track.title.toLocaleLowerCase().includes(needle)) : tracks
  return <MobilePage title="分 P 列表" onBack={onBack} className="mobile-parts-page">
    <div className="mobile-parts-summary"><Artwork src={detail.coverUrl}/><div><h3>{detail.title}</h3><p>{detail.uploaderName} · {tracks.length} 个分 P</p></div></div>
    <label className="mobile-page-search"><Search size={18}/><input type="search" aria-label="搜索分 P" placeholder="搜索分 P" value={query} onChange={event => setQuery(event.target.value)}/></label>
    <VideoPartsList tracks={tracks} visibleTracks={visible}/>
    {!visible.length && <p className="mobile-page-empty">没有匹配的分 P</p>}
  </MobilePage>
}
