import { create } from 'zustand'
import type { SyncOutcome } from './sync'

// Account-scoped, without credentials or persisted copies of cloud content.
type Attention = { library: string; statistics: string; outcome: SyncOutcome | null; reveal: number }
export const useSyncAttention = create<Attention>(() => ({ library: '', statistics: '', outcome: null, reveal: 0 }))
export function reportSyncOutcome(outcome: SyncOutcome, preview = false) {
  useSyncAttention.setState({ outcome: outcome.conflicts.length || preview ? outcome : null,
    library: outcome.conflicts.length ? `有 ${outcome.conflicts.length} 处修改待确认` : preview ? '请完成首次同步' : '' })
}
export function reportSyncError(domain: 'library' | 'statistics', failed: boolean) {
  const state = useSyncAttention.getState()
  // An independent statistics success must not erase library conflicts.
  if (domain === 'library' && state.outcome?.conflicts.length) return
  useSyncAttention.setState({ [domain]: failed ? domain === 'library' ? '同步未完成，点此查看并重试' : '听歌统计同步未完成，点此重试' : '' })
}
export function clearSyncAttention() { useSyncAttention.setState({ library: '', statistics: '', outcome: null }) }
export function revealSync() { useSyncAttention.setState(state => ({ reveal: state.reveal + 1 })) }
