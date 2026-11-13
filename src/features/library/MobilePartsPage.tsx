import { PublishedDate } from '../../shared/PublishedDate'
import { SeasonBrowser } from '../collections/SeasonBrowser'
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { BiliVideoParts } from '../../services/desktopApi'
import { toTrack } from '../../services/collectionTrack'
import { MobilePage } from '../../shared/MobilePage'
import { Artwork } from '../../shared/Artwork'
import { CollectionBookmark } from '../collections/CollectionsView'
import type { Track } from '../../domain/track'
import type { QueueSource } from '../player/playerStore'
import { VideoPartsList } from './VideoPartsList'

export function MobilePartsPage({ detail, onBack, locateCurrent = true, playbackTracks, queueSource, showSeasonLink = true }: { detail: BiliVideoParts; onBack: () => void; locateCurrent?: boolean; playbackTracks?: Track[]; queueSource?: QueueSource; showSeasonLink?: boolean }) {
  const [seasonOpen,setSeasonOpen] = useState(false)
  const [query, setQuery] = useState('')
  const tracks = useMemo(() => detail.parts.map(part => toTrack(detail, part)), [detail])
  const needle = query.trim().toLocaleLowerCase()
  const visible = needle ? tracks.filter(track => track.title.toLocaleLowerCase().includes(needle)) : tracks
  return <MobilePage title={tracks.length > 1 ? '分 P 列表' : '视频详情'} onBack={onBack} className="mobile-parts-page">
    <div className="mobile-parts-summary"><Artwork src={detail.coverUrl}/><div><h3>{detail.title}</h3><p>{detail.uploaderName}{tracks.length > 1 ? ` · ${tracks.length} 个分 P` : ''}</p><PublishedDate value={detail.publishedAt}/></div><CollectionBookmark item={detail}/></div>
    {showSeasonLink && detail.season&&<button className="mobile-row-action" onClick={()=>setSeasonOpen(true)}><span>所属合集 · {detail.season.title}</span><span>›</span></button>}
    <label className="mobile-page-search"><Search size={18}/><input type="search" aria-label="搜索分 P" placeholder="搜索分 P" value={query} onChange={event => setQuery(event.target.value)}/></label>
    <VideoPartsList locateCurrent={locateCurrent} tracks={tracks} visibleTracks={visible} playbackTracks={playbackTracks} queueSource={queueSource ?? { kind: 'video', title: detail.title, collectionRef: detail.bvid }}/>
    {!visible.length && <p className="mobile-page-empty">没有匹配的分 P</p>}
    {seasonOpen&&detail.season&&<SeasonBrowser summary={detail.season} onClose={()=>setSeasonOpen(false)}/>}
  </MobilePage>
}
