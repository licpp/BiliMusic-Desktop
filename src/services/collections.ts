import { invoke } from '@tauri-apps/api/core'
import { inDesktopShell } from './desktopApi'
import { accountEpoch } from './accountScope'
import { accountKeyAt } from './queryKeys'
import type { QueryClient } from '@tanstack/react-query'
export type Collection = { note?: string; followers?: number; bvid: string; folderId: string; title: string; coverUrl: string; uploaderName: string }
export type CollectionProgress = { bvid: string; cid: number; positionMs: number }
export const readCollectionProgress = (reference: string) => invoke<CollectionProgress | null>('collection_progress', { reference })
export type CollectionFolder = { id: string; name: string; scope?: 'collections' | 'creators' }
export type Collections = { folders: CollectionFolder[]; items: Collection[] }
export type SubscribedSeason = { reference: string; title: string; coverUrl: string; uploaderName: string; videoCount: number | null }
export type SubscribedSeasonPage = { items: SubscribedSeason[]; nextPage: number | null }
export const listCollections = (): Promise<Collections> => inDesktopShell ? invoke('collections_list') : Promise.resolve({ folders: [], items: [] })
export const getSubscribedSeasons = (page: number, expectedAccountSession: string) =>
  invoke<SubscribedSeasonPage>('bili_subscribed_seasons', { page, expectedAccountSession })
export async function importSubscribedSeasons(seasons: SubscribedSeason[], expectedAccountSession: string) {
  const epoch = accountEpoch()
  const items: Collection[] = seasons.map(({ reference, title, coverUrl, uploaderName }) =>
    ({ bvid: reference, folderId: '', title, coverUrl, uploaderName }))
  const count = await invoke<number>('collections_import_seasons', { items, expectedAccountSession })
  if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
  if (count > 0) window.dispatchEvent(new Event('bilimusic-data-changed'))
  return count
}
export async function cacheCollectionMetadata(item: Collection, client?: QueryClient, epoch = accountEpoch()) {
  if (!inDesktopShell || epoch !== accountEpoch()) return
  const expectedAccountSession = await invoke<string>('account_session')
  if (epoch !== accountEpoch()) return
  await invoke('collections_change', { action: 'cache', item, expectedAccountSession })
  if (!client || epoch !== accountEpoch()) return
  const key = accountKeyAt(epoch, 'collections')
  client.setQueryData<Collections>(key, previous => {
    const saved = previous?.items.find(entry => entry.bvid === item.bvid)
    if (!saved || saved.title === item.title && saved.coverUrl === item.coverUrl && saved.uploaderName === item.uploaderName) return previous
    return { ...previous!, items: previous!.items.map(entry => entry === saved ? {
      ...entry, title: item.title || entry.title, coverUrl: item.coverUrl || entry.coverUrl, uploaderName: item.uploaderName || entry.uploaderName,
    } : entry) }
  })
}

export async function changeCollection(action: 'save' | 'remove' | 'move' | 'create' | 'createCreator' | 'rename' | 'delete' | 'note', id = '', name = '', item?: Collection) {
  await invoke('collections_change', { action, id, name, item })
  window.dispatchEvent(new Event('bilimusic-data-changed'))
}
