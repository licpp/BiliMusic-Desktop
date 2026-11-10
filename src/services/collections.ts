import { invoke } from '@tauri-apps/api/core'
import { inDesktopShell } from './desktopApi'
export type Collection = { bvid: string; folderId: string; title: string; coverUrl: string; uploaderName: string }
export type CollectionProgress = { bvid: string; cid: number; positionMs: number }
export const readCollectionProgress = (reference: string) => invoke<CollectionProgress | null>('collection_progress', { reference })
export type CollectionFolder = { id: string; name: string }
export type Collections = { folders: CollectionFolder[]; items: Collection[] }
export const listCollections = (): Promise<Collections> => inDesktopShell ? invoke('collections_list') : Promise.resolve({ folders: [], items: [] })
export async function changeCollection(action: 'save' | 'remove' | 'move' | 'create' | 'rename' | 'delete', id = '', name = '', item?: Collection) {
  await invoke('collections_change', { action, id, name, item })
  window.dispatchEvent(new Event('bilimusic-data-changed'))
}
