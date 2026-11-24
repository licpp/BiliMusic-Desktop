import { getVideoParts } from './desktopApi'
import type { BiliVideoParts } from '../domain/bilibili'
import { accountEpoch } from './accountScope'
import { biliRequestPause } from './biliRequestStatus'

type Job = { bvid: string; epoch: number; resolve: (detail: BiliVideoParts) => void; reject: (error: unknown) => void }
const pending = new Map<string, Promise<BiliVideoParts>>()
const waiting: Job[] = []
let running = 0

function drain() {
  while (running < 2 && waiting.length) {
    const job = waiting.shift()!
    if (job.epoch !== accountEpoch()) {
      job.reject(new Error('封面补全暂缓'))
      continue
    }
    running++
    void getVideoParts(job.bvid, false, { background: true }).then(detail => {
      if (job.epoch !== accountEpoch()) throw new Error('账号已切换')
      job.resolve(detail)
    }).catch(error => {
      if (job.epoch === accountEpoch() && biliRequestPause(error)) {
        for (const queued of waiting.splice(0)) queued.reject(error)
      }
      job.reject(error)
    }).finally(() => { running--; drain() })
  }
}

// Statistics from other devices need not have a local tracks row. Fetch only
// source metadata, without importing songs, changing history or counting plays.
export async function getListeningArtwork(id: string): Promise<string | undefined> {
  const match = /^bilibili:(BV[A-Za-z0-9]{10}):(\d+)$/.exec(id)
  if (!match) return undefined
  const [, bvid, cid] = match, epoch = accountEpoch(), key = `${epoch}:${bvid}`
  let request = pending.get(key)
  if (!request) {
    request = new Promise<BiliVideoParts>((resolve, reject) => { waiting.push({ bvid, epoch, resolve, reject }) })
    pending.set(key, request)
    void request.finally(() => pending.delete(key)).catch(() => undefined)
    drain()
  }
  const detail = await request
  if (epoch !== accountEpoch()) return undefined
  return detail.parts.find(part => String(part.cid) === cid)?.coverUrl || detail.coverUrl || undefined
}
