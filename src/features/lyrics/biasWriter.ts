import type { StoredLyrics } from '../../domain/lyrics'

type Adjustment = { expected: StoredLyrics; biasMs: number }
const selectionKey = ({ trackId, accountSession, writeToken }: StoredLyrics) =>
  JSON.stringify([trackId, accountSession, writeToken])

// Only the newest value needs saving. Serialize writes so a slow response can
// never overwrite a later adjustment, including when the lyrics page closes.
export function createBiasWriter(
  save: (expected: StoredLyrics, biasMs: number) => Promise<StoredLyrics>,
  onResult: (expected: StoredLyrics, biasMs: number, error?: unknown) => void,
  delay = 200,
) {
  const pending = new Map<string, Adjustment>()
  let active: { key: string; adjustment: Adjustment; generation: number } | undefined
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  const flush = (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    if (running) return running.then(() => pending.size ? flush() : undefined)
    running = (async () => {
      while (pending.size) {
        const [key, adjustment] = pending.entries().next().value!
        pending.delete(key)
        const attempt = { key, adjustment, generation }
        active = attempt
        try {
          const saved = await save(adjustment.expected, adjustment.biasMs)
          if (attempt.generation !== generation) continue
          const next = pending.get(key)
          if (next) next.expected = saved
          onResult(adjustment.expected, adjustment.biasMs)
        } catch (error) {
          if (attempt.generation === generation) onResult(adjustment.expected, adjustment.biasMs, error)
        } finally {
          active = undefined
        }
      }
    })().finally(() => { running = undefined })
    return running
  }
  return {
    set(expected: StoredLyrics, biasMs: number) {
      const key = selectionKey(expected)
      const writing = active?.key === key && active.generation === generation ? active.adjustment : undefined
      pending.set(key, { expected: pending.get(key)?.expected ?? writing?.expected ?? expected, biasMs })
      clearTimeout(timer)
      timer = setTimeout(() => { void flush() }, delay)
    },
    flush,
    cancel() { generation++; clearTimeout(timer); pending.clear() },
  }
}

export const clampBias = (milliseconds: number) => Math.max(-30_000, Math.min(30_000, Math.round(milliseconds)))
