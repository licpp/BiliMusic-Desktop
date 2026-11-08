import { useQuery } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import type { SeasonSummary } from '../../services/mediaSources'
import { seasonReference } from '../../services/mediaSources'
import { getVideoParts, commandErrorMessage } from '../../services/desktopApi'
import { isMobile } from '../../services/platform'
import { MobilePage } from '../../shared/MobilePage'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { CollectionDetail } from './CollectionsView'

export function SeasonBrowser({ bvid, summary, onClose }: { bvid?:string; summary?:SeasonSummary; onClose:()=>void }) {
  const lookup=useQuery({queryKey:['video-season',bvid],queryFn:()=>getVideoParts(bvid!),enabled:!summary && Boolean(bvid),staleTime:300000})
  const season=summary || lookup.data?.season
  const content=season ? <CollectionDetail embedded item={{bvid:seasonReference(season),folderId:'',title:season.title,coverUrl:season.coverUrl,uploaderName:season.uploaderName}} onBack={onClose}/> : <div className="mobile-page-empty">{lookup.isLoading ? <><LoaderCircle className="spin" size={20}/>读取所属合集</> : lookup.error ? commandErrorMessage(lookup.error) : '这个视频没有所属的 B 站合集'}</div>
  return isMobile ? <MobilePage title="B 站合集" onBack={onClose}>{content}</MobilePage> : <CollectionDialog title="B 站合集" onClose={onClose}>{content}</CollectionDialog>
}
