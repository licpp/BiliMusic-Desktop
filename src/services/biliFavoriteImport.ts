import type { FavoriteFolder, FavoritePage, BiliVideoParts, Playlist } from './desktopApi'
import { toTrack } from './collectionTrack'
import type { Track } from '../domain/track'
import { commandErrorMessage, isConnectionError } from './userErrors'

export type FolderImportResult = { folderId: number; name: string; id?: string; count: number; error?: string }
type ImportOptions = {
  folders: FavoriteFolder[]; mode: 'copy' | 'link'; scope: string; copyIds: Map<number, string>
  stopped: () => boolean; progress: (text: string) => void; result: (value: FolderImportResult) => void
  link: (id: number) => Promise<unknown>
  videos: (id: number, page: number) => Promise<FavoritePage>
  detail: (bvid: string) => Promise<BiliVideoParts>
  save: (scope: string, id: string, name: string, entries: { track: Track }[]) => Promise<Playlist>
  wait?: (ms: number) => Promise<void>
}
export const biliRequestLimited = (error: unknown) => /(?:\b412\b|\b429\b|-352|-412|-509|-799|请求.*限制|请求.*频繁)/.test(String(typeof error === 'object' && error && 'message' in error ? error.message : error))
const transient = (error: unknown) => biliRequestLimited(error) || isConnectionError(error) || /超时|timeout/i.test(String(error))

export async function importFavoriteFolders(options: ImportOptions) {
  const { stopped, progress } = options
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const cancelled = () => { if (stopped()) throw new Error('导入已停止') }
  let reads = 0
  async function read<T>(request: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      cancelled()
      if (reads++) await wait(400)
      cancelled()
      try { const data = await request(); cancelled(); return data }
      catch (error) {
        cancelled()
        if (attempt >= 2 || !transient(error)) throw error
        progress(`${biliRequestLimited(error) ? 'B 站暂时限制了请求' : '连接暂时中断'}，稍后重试（${attempt + 1}/2）…`)
        await wait(1500 * 2 ** attempt)
      }
    }
  }
  const results: FolderImportResult[] = []
  for (const [index, folder] of options.folders.entries()) {
    if (stopped()) break
    let count = 0, id: string | undefined, failures = 0
    progress(`正在${options.mode === 'link' ? '关联' : '导入'}「${folder.title}」 · ${index + 1}/${options.folders.length}`)
    try {
      if (options.mode === 'link') {
        await options.link(folder.id)
        cancelled()
        id = `bili-folder:${folder.id}`
      } else {
        const target = options.copyIds.get(folder.id) ?? `import:${crypto.randomUUID()}`
        options.copyIds.set(folder.id, target)
        const seen = new Set<string>()
        for (let page = 1; ; page++) {
          if (page > 500) throw new Error('收藏夹超过可读取的页数')
          const data = await read(() => options.videos(folder.id, page))
          if (!data.medias?.length && data.has_more) throw new Error('收藏夹返回不完整，请稍后重试')
          for (const video of data.medias ?? []) {
            cancelled()
            if (seen.has(video.bvid)) continue
            seen.add(video.bvid)
            progress(`「${folder.title}」 · 正在读取「${video.title}」 · 已保存 ${count} 首`)
            let detail: BiliVideoParts
            try { detail = await read(() => options.detail(video.bvid)) }
            catch (error) { cancelled(); if (transient(error) || /401|-101|登录/.test(String(typeof error === 'object' && error && 'message' in error ? error.message : error))) throw error; failures++; continue }
            for (let offset = 0; offset < detail.parts.length; offset += 100) {
              cancelled()
              const saved = await options.save(options.scope, target, folder.title.slice(0, 80), detail.parts.slice(offset, offset + 100).map(part => ({ track: toTrack(detail, part) })))
              cancelled(); id = target; count = saved.trackCount
            }
          }
          if (!data.has_more) break
        }
        if (!id) throw new Error('收藏夹中没有可导入的歌曲')
        if (failures) throw new Error(`${failures} 个视频暂不可读取，已保留导入的 ${count} 首歌曲`)
      }
      cancelled()
      const result = { folderId: folder.id, name: folder.title, id, count }
      results.push(result); options.result(result)
    } catch (error) {
      if (stopped()) break
      const result = { folderId: folder.id, name: folder.title, id, count, error: commandErrorMessage(error, '读取收藏夹失败，请稍后重试') }
      results.push(result); options.result(result)
    }
  }
  return results
}
