import { invoke } from '@tauri-apps/api/core'
import type { BiliVideoPart, BiliVideoParts } from '../domain/bilibili'
import { accountEpoch } from './accountScope'
import { biliRequestPause } from './biliRequestStatus'

type VideoReadOptions = { background?: boolean; resume?: boolean }

const cache = new Map<string, { expires: number; pages: BiliVideoPart[] }>()
const inFlight = new Map<string, Promise<BiliVideoPart[]>>()
const cacheKey = (bvid: string) => `${accountEpoch()}:${bvid}`
const videoDetails = new Map<string, { expires: number; request: Promise<BiliVideoParts>; detail?: BiliVideoParts }>()

export function cachedVideoDetail(bvid: string) {
  const item = videoDetails.get(cacheKey(bvid))
  return item && item.expires > Date.now() ? item.detail : undefined
}

export function getVideoParts(bvid: string, refresh = false, options?: VideoReadOptions) {
  const key = cacheKey(bvid)
  const saved = videoDetails.get(key)
  if (saved && (!saved.detail || !refresh && saved.expires > Date.now())) return saved.request
  const entry = {
    expires: Date.now() + 120_000,
    request: invoke<BiliVideoParts>('bili_video_parts', { bvid, ...(refresh && { refresh }), ...options }).then(detail => {
      if (key === cacheKey(bvid) && videoDetails.get(key) === entry) {
        entry.detail = detail
        entry.expires = Date.now() + 120_000
        rememberVideoPages(bvid, detail.parts)
      }
      return detail
    }),
    detail: undefined as BiliVideoParts | undefined,
  }
  videoDetails.set(key, entry)
  if (videoDetails.size > 100) videoDetails.delete(videoDetails.keys().next().value!)
  void entry.request.catch(() => { if (videoDetails.get(key) === entry) videoDetails.delete(key) })
  return entry.request
}

export function cachedVideoPages(bvid: string) {
  const item = cache.get(cacheKey(bvid))
  return item && item.expires > Date.now() ? item.pages : undefined
}

export function rememberVideoPages(bvid: string, pages: BiliVideoPart[]) {
  if (!pages.length) return
  cache.set(cacheKey(bvid), { expires: Date.now() + 300_000, pages })
  if (cache.size > 512) cache.delete(cache.keys().next().value!)
}

export function getVideoPages(bvid: string, options?: VideoReadOptions): Promise<BiliVideoPart[]> {
  const saved = cachedVideoPages(bvid)
  if (saved) return Promise.resolve(saved)
  const key = cacheKey(bvid)
  const existing = inFlight.get(key)
  if (existing) return existing
  const pending = invoke<BiliVideoPart[]>('bili_video_pagelist', { bvid, ...options }).then(pages => {
    if (key === cacheKey(bvid)) rememberVideoPages(bvid, pages)
    return pages
  }).finally(() => inFlight.delete(key))
  inFlight.set(key, pending)
  return pending
}

type Probe = { scope: number; bvid: string; signal: AbortSignal; onPages: (pages: BiliVideoPart[], detail?: BiliVideoParts) => void; withAccess?: boolean }
const waiting: Probe[] = []
let running = 0

function drain() {
  while (running < 2 && waiting.length) {
    const job = waiting.shift()!
    if (job.signal.aborted || job.scope !== accountEpoch()) continue
    running++
    const request = job.withAccess
      ? getVideoParts(job.bvid, false, { background: true }).then(detail => ({ pages: detail.parts, detail }))
      : getVideoPages(job.bvid, { background: true }).then(pages => ({ pages, detail: undefined }))
    void request.then(({ pages, detail }) => {
      if (!job.signal.aborted && job.scope === accountEpoch()) job.onPages(pages, detail)
    }).catch(error => {
      if (job.scope === accountEpoch() && biliRequestPause(error)) waiting.length = 0
    }).finally(() => { running--; drain() })
  }
}

export function probeVideoPages(job: Probe) {
  const detail = cachedVideoDetail(job.bvid)
  if (detail) { job.onPages(detail.parts, detail); return }
  const saved = cachedVideoPages(job.bvid)
  if (!job.withAccess && saved) { job.onPages(saved); return }
  waiting.push(job)
  drain()
}
