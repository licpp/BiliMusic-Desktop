import { invoke } from '@tauri-apps/api/core'
import { accountEpoch } from '../services/accountScope'
import { getVideoParts } from '../services/desktopApi'
import { getSeason, getSeasonCover, parseSeasonReference } from '../services/mediaSources'
import { cacheCollectionMetadata, type Collection } from '../services/collections'

let pending: Promise<unknown> = Promise.resolve()
// Metadata is a local cache, intentionally absent from the synchronized membership record.
// Only visible missing cards request it, one at a time to avoid bursts after first sync.
export function loadCollectionMetadata(item: Collection, epoch: number): Promise<Collection> {
  const result = pending.catch(() => undefined).then(async () => {
    if (epoch !== accountEpoch()) throw Error('账号已切换')
    try {
      let metadata: Pick<Collection, 'title' | 'coverUrl' | 'uploaderName'>
      if (item.bvid.startsWith('up:')) {
        const profile = await invoke<{ data: { card?: { name: string; face: string } } }>('bili_creator_catalog', { action: 'profile', mid: Number(item.bvid.slice(3)), page: 1, keyword: '' })
        if (!profile.data.card?.name) throw Error('暂时无法读取 UP 主信息')
        metadata = { title: profile.data.card.name, coverUrl: profile.data.card.face, uploaderName: profile.data.card.name }
      } else {
        const reference = parseSeasonReference(item.bvid)
        const detail = reference && item.title && item.title !== item.bvid
          ? { ...item, coverUrl: (await getSeasonCover(reference)) || item.coverUrl }
          : reference ? (await getSeason(reference.mid, reference.seasonId)).summary : await getVideoParts(item.bvid)
        metadata = { title: detail.title, coverUrl: detail.coverUrl, uploaderName: detail.uploaderName }
      }
      if (epoch !== accountEpoch()) throw Error('账号已切换')
      const value = { ...item, ...metadata }
      await cacheCollectionMetadata(value, undefined, epoch)
      return value
    } finally { await new Promise(resolve => setTimeout(resolve, 300)) }
  })
  pending = result
  return result
}
