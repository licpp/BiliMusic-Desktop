// Only the newest value needs saving. Serialize writes so a slow response can
// never overwrite a later adjustment, including when the lyrics page closes.
export function createBiasWriter(
  save: (trackId: string, biasMs: number) => Promise<unknown>,
  onResult: (trackId: string, biasMs: number, error?: unknown) => void,
  delay = 200,
) {
  const pending = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  const flush = (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    if (running) return running.then(() => pending.size ? flush() : undefined)
    running = (async () => {
      while (pending.size) {
        const [id, value] = pending.entries().next().value!
        pending.delete(id)
        try { await save(id, value); onResult(id, value) }
        catch (error) { onResult(id, value, error) }
      }
    })().finally(() => { running = undefined })
    return running
  }
  return {
    set(trackId: string, biasMs: number) {
      pending.set(trackId, biasMs)
      clearTimeout(timer)
      timer = setTimeout(() => { void flush() }, delay)
    },
    flush,
    cancel() { clearTimeout(timer); pending.clear() },
  }
}

export const clampBias = (milliseconds: number) => Math.max(-30_000, Math.min(30_000, Math.round(milliseconds)))
