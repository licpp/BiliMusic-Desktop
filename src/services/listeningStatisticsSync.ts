import { invoke } from '@tauri-apps/api/core'
import type { QueryClient } from '@tanstack/react-query'
import { accountEpoch } from './accountScope'

// Account statistics have their own schedule; library consent, conflicts and pause do not gate it.
export function startAccountStatisticsSync(client: QueryClient) {
  let stopped = false, switching = false, busy = false, requested = false, next = 0
  const run = async (force = false) => {
    if (stopped || switching || document.hidden) return
    if (busy) { requested ||= force; return }
    if (!force && Date.now() < next) return
    busy = true
    const epoch = accountEpoch()
    try {
      await invoke('listening_sync')
      if (epoch === accountEpoch() && !stopped && !switching) {
        next = Date.now() + 15 * 60_000
        await client.invalidateQueries({ queryKey: ['listening-statistics'] })
      }
    } catch {
      if (epoch === accountEpoch() && !stopped && !switching) {
        next = Date.now() + 15 * 60_000
        await client.invalidateQueries({ queryKey: ['listening-statistics'] })
      }
    } finally {
      busy = false
      if (requested) { requested = false; void run(true) }
    }
  }
  const request = () => { next = 0; void run(true) }
  const changing = () => { switching = true; requested = false; next = 0 }
  const changed = () => { switching = false; request() }
  const foreground = () => { if (!document.hidden) request() }
  const interval = window.setInterval(() => void run(), 60_000)
  window.addEventListener('bilimusic-account-changing', changing)
  window.addEventListener('bilimusic-account-changed', changed)
  window.addEventListener('bilimusic-statistics-sync-requested', request)
  window.addEventListener('online', request)
  document.addEventListener('visibilitychange', foreground)
  void run()
  return () => {
    stopped = true; window.clearInterval(interval)
    window.removeEventListener('bilimusic-account-changing', changing)
    window.removeEventListener('bilimusic-account-changed', changed)
    window.removeEventListener('bilimusic-statistics-sync-requested', request)
    window.removeEventListener('online', request)
    document.removeEventListener('visibilitychange', foreground)
  }
}
