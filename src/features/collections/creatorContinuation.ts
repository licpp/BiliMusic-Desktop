import type { BiliVideoParts } from '../../domain/bilibili'
import { accountEpoch } from '../../services/accountScope'
import type { Collection, CollectionProgress } from '../../services/collections'
import { toTrack } from '../../services/collectionTrack'
import { getVideoParts } from '../../services/desktopApi'
import { creatorVideoRow, parseSeasonReference, seasonCollection } from '../../services/mediaSources'
import { playbackIntent, seasonPlaybackQueue, usePlayerStore } from '../player/playerStore'

export type CollectionResumeRequest = { checkpoint: CollectionProgress; account: number; intent: number }
export type OpenCollection = (collection: Collection, resume?: CollectionResumeRequest) => void
export type CreatorVideo = Parameters<typeof creatorVideoRow>[0]
export type CreatorUploadPage = { page: number; data: { page?: { count: number }; list?: { vlist: CreatorVideo[] } } }

export function createCollectionResume(checkpoint: CollectionProgress): CollectionResumeRequest {
  return { checkpoint, account: accountEpoch(), intent: playbackIntent() }
}

export function isCurrentCollectionResume(request: CollectionResumeRequest) {
  return request.account === accountEpoch() && request.intent === playbackIntent()
}

export async function resolveCreatorContinuation(checkpoint: CollectionProgress, creator: Collection, current: () => boolean): Promise<{ collection: Collection } | { detail: BiliVideoParts } | undefined> {
  if (!current()) return
  const mid = Number(creator.bvid.slice(3))
  const reference = checkpoint.collectionRef && parseSeasonReference(checkpoint.collectionRef)
  if (reference && reference.mid === mid) {
    return { collection: { bvid: `season:${reference.mid}:${reference.seasonId}`, folderId: '', title: 'B 站合集', coverUrl: '', uploaderName: creator.title } }
  }
  const detail = await getVideoParts(checkpoint.bvid)
  if (!current()) return
  return detail.season?.uploaderId === mid ? { collection: seasonCollection(detail.season) } : { detail }
}

export async function resumeCreatorUploads(
  creator: Collection, checkpoint: CollectionProgress, detail: BiliVideoParts,
  current: () => boolean, fetchPage: (page: number) => Promise<CreatorUploadPage>, initial: CreatorUploadPage[] = [],
) {
  const mid = Number(creator.bvid.slice(3))
  let page = initial.at(-1)?.page || 0
  const entries = new Map(initial.flatMap(result => result.data.list?.vlist || []).map(video => [video.bvid, video]))
  let total = initial[0]?.data.page?.count ?? Infinity
  while (current() && !entries.has(checkpoint.bvid) && page * 30 < total) {
    const result = await fetchPage(++page)
    if (!current()) return
    const rows = result.data.list?.vlist || []
    if (!rows.length) break
    for (const video of rows) entries.set(video.bvid, video)
    total = result.data.page?.count ?? entries.size
  }
  if (!current()) return
  if (!entries.has(checkpoint.bvid)) throw new Error('上次播放的视频已不在这个 UP 主的投稿中')
  const parts = detail.parts.map(part => toTrack(detail, part))
  const selected = parts.find(track => track.source.cid === checkpoint.cid)
  if (!selected) throw new Error('上次播放的分 P 已不可用')
  const uploads = [...entries.values()].map(video => creatorVideoRow(video, mid, creator.title))
  await usePlayerStore.getState().playFromList(seasonPlaybackQueue(uploads, selected, parts), selected.id, {
    kind: 'season', title: creator.title, collectionRef: creator.bvid, creatorMid: mid,
    creatorPage: page, creatorTotal: Number.isFinite(total) ? total : entries.size,
  }, checkpoint.positionMs / 1000, true)
}
