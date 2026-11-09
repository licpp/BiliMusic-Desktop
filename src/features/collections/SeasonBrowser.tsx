import { seasonCollection, type SeasonSummary } from '../../services/mediaSources'
import { MobilePage } from '../../shared/MobilePage'
import { CollectionDetail } from './CollectionsView'

export function SeasonBrowser({ summary, onClose }: { summary: SeasonSummary; onClose: () => void }) {
  return <MobilePage title="B 站合集" onBack={onClose}>
    <CollectionDetail embedded item={seasonCollection(summary)} onBack={onClose}/>
  </MobilePage>
}
