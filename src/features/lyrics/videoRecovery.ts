import { createOperationScope } from '../player/operationScope'

export function createVideoRefreshScope() {
  const operations = createOperationScope()
  let active = false
  return {
    activate() {
      active = true
      return () => { active = false; operations.invalidate() }
    },
    async refresh<T>(isCurrent: () => boolean, load: () => Promise<T>, commit: (value: T) => void) {
      if (!active || !isCurrent()) return false
      const latest = operations.begin('video-source')
      const valid = () => active && latest() && isCurrent()
      try {
        const value = await load()
        if (!valid()) return false
        commit(value)
        return true
      } catch (error) {
        if (!valid()) return false
        throw error
      }
    },
  }
}

// Keep a bounded recovery budget across source URL changes. Re-loading an
// expired CDN URL alone cannot recover a decoder/network error.
export function createVideoRecovery(options: {
  refresh: () => Promise<boolean | void>
  restart: () => void
  busy: (value: boolean) => void
  failed: (cause: unknown) => void
}) {
  let disposed = false, automaticAttempts = 0
  let pending: Promise<boolean> | undefined
  return {
    recover(manual = false): Promise<boolean> {
      if (disposed) return Promise.resolve(false)
      if (pending) return pending
      if (manual) automaticAttempts = 0
      else if (automaticAttempts >= 2) return Promise.resolve(false)
      else automaticAttempts++
      options.busy(true)
      pending = Promise.resolve().then(() => disposed ? false : options.refresh()).then(refreshed => {
        if (disposed || refreshed === false) return false
        options.restart()
        return true
      }).catch(cause => {
        if (!disposed) options.failed(cause)
        return false
      }).finally(() => {
        pending = undefined
        if (!disposed) options.busy(false)
      })
      return pending
    },
    healthy() { automaticAttempts = 0 },
    dispose() { disposed = true },
  }
}
