import { seasonReference, type SeasonSummary } from '../../services/mediaSources'
import { isMobile } from '../../services/platform'
import { MobilePage } from '../../shared/MobilePage'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { CollectionDetail } from './CollectionsView'

export function SeasonBrowser({ summary, onClose }: { summary: SeasonSummary; onClose: () => void }) {
  const item = {
    bvid: seasonReference(summary),
    folderId: '',
    title: summary.title,
    coverUrl: summary.coverUrl,
    uploaderName: summary.uploaderName,
  }
  const content = <CollectionDetail embedded item={item} onBack={onClose}/>
  return isMobile
    ? <MobilePage title="B 站合集" onBack={onClose}>{content}</MobilePage>
    : <CollectionDialog wide title="B 站合集" onClose={onClose}>{content}</CollectionDialog>
}
