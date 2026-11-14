import { invoke } from '@tauri-apps/api/core'
import type { QueryClient } from '@tanstack/react-query'
import type { SyncOutcome } from './sync'
import { accountEpoch } from './accountScope'
import { clearSyncAttention, reportSyncOutcome, reportSyncError } from './syncAttention'

type Hint = 'tick' | 'data' | 'foreground' | 'online' | 'statistics' | 'configured'
type Report = { library?: SyncOutcome; libraryError?: string; statistics: boolean; statisticsError?: string }

// Lifecycle bridge only. Rust owns cadence, dirty deadlines, backoff and both domains.
export function startBackgroundSync(client: QueryClient, onLibrary: (outcome: SyncOutcome) => Promise<void> = async () => {}) {
  let stopped = false, switching = false
  const run = async (hint: Hint) => {
    if (stopped || switching || document.hidden) return
    const epoch = accountEpoch()
    try {
      const report = await invoke<Report>('sync_background', { hint })
      if (stopped || switching || epoch !== accountEpoch()) return
      if (report.statistics || report.statisticsError) await client.invalidateQueries({ queryKey: ['listening-statistics'] })
      if (stopped || switching || epoch !== accountEpoch()) return
      if (report.statistics) reportSyncError('statistics', false)
      if (report.statisticsError) reportSyncError('statistics', true)
      if (report.library) {
        reportSyncOutcome(report.library)
        await onLibrary(report.library)
        if (stopped || switching || epoch !== accountEpoch()) return
        await client.invalidateQueries({ queryKey: ['sync-status'] })
        if (stopped || switching || epoch !== accountEpoch()) return
        if (!report.library.conflicts.length) window.dispatchEvent(new CustomEvent('bilimusic-sync-status', { detail: '' }))
      }
      if (report.libraryError) reportSyncError('library', true)
      if (report.libraryError) window.dispatchEvent(new CustomEvent('bilimusic-sync-status', { detail: '同步暂未完成，请到设置中查看或手动重试' }))
    } catch {
      if (!stopped && !switching && epoch === accountEpoch()) reportSyncError('library', true)
      // No retry loop here. The next lifecycle hint/heartbeat reaches the Rust policy.
    } finally {
      if (!stopped && !switching && epoch !== accountEpoch()) void run('foreground')
    }
  }
  const changing = () => { switching = true; clearSyncAttention() }
  const changed = () => { switching = false; void run('configured') }
  const configured = () => void run('configured')
  const statistics = () => void run('statistics')
  const data = () => void run('data')
  const online = () => void run('online')
  const foreground = () => { if (!document.hidden) void run('foreground') }
  // The heartbeat performs local admission only; it does not imply any WebDAV request.
  const interval = window.setInterval(() => void run('tick'), 1_000)
  window.addEventListener('bilimusic-account-changing', changing)
  window.addEventListener('bilimusic-account-changed', changed)
  window.addEventListener('bilimusic-sync-configured', configured)
  window.addEventListener('bilimusic-statistics-sync-requested', statistics)
  window.addEventListener('bilimusic-data-changed', data)
  window.addEventListener('online', online)
  document.addEventListener('visibilitychange', foreground)
  // A new app session retries a prior conflict/auth block once, preserving backoff and rate limits.
  void run('configured')
  return () => {
    stopped = true; window.clearInterval(interval)
    window.removeEventListener('bilimusic-account-changing', changing)
    window.removeEventListener('bilimusic-account-changed', changed)
    window.removeEventListener('bilimusic-sync-configured', configured)
    window.removeEventListener('bilimusic-statistics-sync-requested', statistics)
    window.removeEventListener('bilimusic-data-changed', data)
    window.removeEventListener('online', online)
    document.removeEventListener('visibilitychange', foreground)
  }
}
