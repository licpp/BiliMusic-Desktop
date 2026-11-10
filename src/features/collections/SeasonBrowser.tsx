import { seasonCollection, type SeasonSummary } from '../../services/mediaSources'
import { MobilePage } from '../../shared/MobilePage'
import { CollectionDetail } from './CollectionsView'

export function SeasonBrowser({ summary, onClose, locateCurrent = true }: { summary: SeasonSummary; onClose: () => void; locateCurrent?: boolean }) {
  return <MobilePage title="B 站合集" onBack={onClose}>
    <CollectionDetail embedded locateCurrent={locateCurrent} item={seasonCollection(summary)} onBack={onClose}/>
  </MobilePage>
}
