// Android has no second webview, so the NetEase web login replaces the app page
// and the app reloads on the way back. Whatever the dialog held in memory is
// gone by then, so the login leaves a marker here: after the reload the app
// opens the recommendations page and reopens the dialog that started it.
//
// `localStorage` survives the reload, unlike component state; the marker is
// one-shot (peek then clear) and expires so a marker abandoned by a killed app
// cannot pop the dialog open minutes later.
const KEY = 'bilimusic.recommendation.web-login'
const MAX_AGE = 15 * 60 * 1000

export type WebLoginReturn = {
  startedAt: number
  /** Sources that already existed, so the app can tell which one the login added. */
  sourceIds: string[]
}

export function markWebLoginReturn(sourceIds: string[], now = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ startedAt: now, sourceIds }))
  } catch {
    // No storage: the login still works, the dialog just does not come back.
  }
}

export function peekWebLoginReturn(now = Date.now()): WebLoginReturn | undefined {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return undefined
  }
  if (!raw) return undefined
  let parsed: Partial<WebLoginReturn> | undefined
  try {
    parsed = JSON.parse(raw) as Partial<WebLoginReturn>
  } catch {
    parsed = undefined
  }
  const fresh = typeof parsed?.startedAt === 'number' && parsed.startedAt <= now && now - parsed.startedAt <= MAX_AGE
  if (!fresh) {
    clearWebLoginReturn()
    return undefined
  }
  return {
    startedAt: parsed!.startedAt!,
    sourceIds: Array.isArray(parsed!.sourceIds) ? parsed!.sourceIds.filter(id => typeof id === 'string') : [],
  }
}

export function clearWebLoginReturn(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

/** The source the interrupted login added, judged by what existed before it. */
export function sourceAddedByLogin<T extends { id: string }>(sources: T[], marker: WebLoginReturn): T | undefined {
  return sources.find(source => !marker.sourceIds.includes(source.id))
}

/**
 * The backend outcome that belongs to this marker. The login ends after the
 * marker is written, so an older outcome means the reload is not the one this
 * attempt caused and says nothing about it.
 */
export function outcomeForAttempt<T extends { finishedAt: number }>(
  outcome: T | undefined,
  marker: WebLoginReturn,
): T | undefined {
  return outcome && outcome.finishedAt >= marker.startedAt ? outcome : undefined
}

/**
 * The outcome can arrive after the reload that reads it: when the back key
 * reloads the app page, the backend login loop notices the URL change up to one
 * poll later and only then leaves the result. A login that ended before the
 * reload is there on the first read, so this costs nothing in that case.
 */
export async function outcomeAfterReload<T>(
  read: () => Promise<T | undefined>,
  wait: (milliseconds: number) => Promise<unknown> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  attempts = 12,
  intervalMilliseconds = 150,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const outcome = await read().catch(() => undefined)
    if (outcome) return outcome
    if (attempt < attempts - 1) await wait(intervalMilliseconds)
  }
  return undefined
}
