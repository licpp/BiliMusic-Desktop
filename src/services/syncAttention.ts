import { create } from 'zustand'
import type { SyncOutcome } from './sync'
import { describeSyncIssue, type SyncIssue } from './syncIssues'

// Account-scoped, without credentials or persisted copies of cloud content.
type Attention = { library: string; statistics: string; libraryIssue: SyncIssue | null; statisticsIssue: SyncIssue | null; outcome: SyncOutcome | null; reveal: number }
export const useSyncAttention = create<Attention>(() => ({ library: '', statistics: '', libraryIssue: null, statisticsIssue: null, outcome: null, reveal: 0 }))
export function reportSyncOutcome(outcome: SyncOutcome, preview = false) {
  if (outcome.skipped) return
  useSyncAttention.setState({ outcome: outcome.conflicts.length || preview ? outcome : null,
    libraryIssue: null,
    library: outcome.conflicts.length ? `有 ${outcome.conflicts.length} 处修改待确认` : preview ? '请完成首次同步' : outcome.importError || outcome.visibilityError || outcome.chaptersError || outcome.favoriteOrderError ? '部分资料待同步' : '' })
}
export function reportSyncError(domain: 'library' | 'statistics', failed: boolean, error?: unknown) {
  const state = useSyncAttention.getState()
  const issue = failed ? describeSyncIssue(error) : null
  if (domain === 'library') useSyncAttention.setState({
    library: state.outcome?.conflicts.length ? state.library : issue ? '同步待处理' : '',
    libraryIssue: issue,
  })
  else useSyncAttention.setState({ statistics: issue ? '听歌统计待同步' : '', statisticsIssue: issue })
}
export function clearSyncAttention() { useSyncAttention.setState({ library: '', statistics: '', libraryIssue: null, statisticsIssue: null, outcome: null }) }
export function revealSync() { useSyncAttention.setState(state => ({ reveal: state.reveal + 1 })) }
