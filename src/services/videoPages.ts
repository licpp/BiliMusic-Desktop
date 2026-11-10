import { invoke } from '@tauri-apps/api/core'
import type { BiliVideoPart } from './desktopApi'
import { accountEpoch } from './accountScope'

const cache = new Map<string, { expires: number; pages: BiliVideoPart[] }>()
const inFlight = new Map<string, Promise<BiliVideoPart[]>>()
const cacheKey = (bvid: string) => `${accountEpoch()}:${bvid}`

export function cachedVideoPages(bvid: string) {
  const item = cache.get(cacheKey(bvid))
  return item && item.expires > Date.now() ? item.pages : undefined
}

export function rememberVideoPages(bvid: string, pages: BiliVideoPart[]) {
  if (!pages.length) return
  cache.set(cacheKey(bvid), { expires: Date.now() + 300_000, pages })
  if (cache.size > 512) cache.delete(cache.keys().next().value!)
}

export function getVideoPages(bvid: string): Promise<BiliVideoPart[]> {
  const saved = cachedVideoPages(bvid)
  if (saved) return Promise.resolve(saved)
  const key = cacheKey(bvid)
  const existing = inFlight.get(key)
  if (existing) return existing
  const pending = invoke<BiliVideoPart[]>('bili_video_pagelist', { bvid }).then(pages => {
    if (key === cacheKey(bvid)) rememberVideoPages(bvid, pages)
    return pages
  }).finally(() => inFlight.delete(key))
  inFlight.set(key, pending)
  return pending
}

type Probe = { scope: number; bvid: string; signal: AbortSignal; onPages: (pages: BiliVideoPart[]) => void }
const waiting: Probe[] = []
let running = 0
let cooldownUntil = 0

function drain() {
  // Leave one native request slot available for playback or a deliberate tap.
  while (running < 2 && waiting.length) {
    const job = waiting.shift()!
    if (job.signal.aborted || job.scope !== accountEpoch() || Date.now() < cooldownUntil) continue
    running++
    void getVideoPages(job.bvid).then(pages => {
      if (!job.signal.aborted) job.onPages(pages)
    }).catch(error => {
      const message = typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error)
      if (/\b(412|429)\b/.test(message)) cooldownUntil = Date.now() + 60_000
    }).finally(() => { running--; drain() })
  }
}

export function probeVideoPages(job: Probe) {
  const saved = cachedVideoPages(job.bvid)
  if (saved) { job.onPages(saved); return }
  waiting.push(job)
  drain()
}
