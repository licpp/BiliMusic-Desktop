import { useState } from 'react'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { accountEpoch } from '../../services/accountScope'
import { copyText } from '../../shared/copyText'
import type { SyncConfig, SyncOutcome } from '../../services/sync'
import type { SyncIssue } from '../../services/syncIssues'
import { SyncConflicts } from './SyncConflicts'

export type IssueArea = '音乐库' | '本机资料' | '导入歌单' | '隐藏偏好' | '章节' | '听歌统计' | '我喜欢的排序'

export function SyncRecovery({ issues, outcome, config, busy, message, onClose, onMerge, onRetry, onReconnect, onBackup }: {
  issues: { area: IssueArea; issue: SyncIssue }[]
  outcome: SyncOutcome | null
  config?: SyncConfig
  busy: boolean
  message: string
  onClose: () => void
  onMerge: (resolution: string) => void
  onRetry: (statisticsOnly: boolean) => void
  onReconnect: () => void
  onBackup?: () => void
}) {
  const [copyStatus, setCopyStatus] = useState('')
  const conflicts = outcome?.conflicts ?? []
  const connection = issues.some(({ issue }) => issue.kind === 'connection')
  const backup = onBackup && issues.some(({ issue }) => issue.kind === 'data' || issue.kind === 'limit')
  const copy = async () => {
    const session = accountEpoch()
    const details = issues.map(({ area, issue }) =>
      `${area} · ${issue.kind}${issue.status ? ` · HTTP ${issue.status}` : ''}`)
    if (conflicts.length) details.push(`待确认修改 ${conflicts.length} 处`)
    try {
      await copyText(['BiliMusic 云同步', ...details].join('\n'))
      if (session === accountEpoch()) setCopyStatus('诊断信息已复制')
    } catch {
      if (session === accountEpoch()) setCopyStatus('复制失败，请稍后重试')
    }
  }
  const hasStatisticsIssue = issues.some(({ area }) => area === '听歌统计')
  const hasLibraryIssue = conflicts.length > 0 || issues.some(({ area }) => area !== '听歌统计')
  const needsPreview = conflicts.length > 0 || issues.some(({ issue }) => issue.kind === 'conflict')
  return <CollectionDialog title="处理同步问题" className="sync-settings sync-recovery" mobileSheet onClose={onClose}>
    {issues.length > 0 && <ul className="sync-recovery-issues">
      {issues.map(({ area, issue }) => <li key={area}>
        <strong>{area}</strong>{issue.status && <small>HTTP {issue.status}</small>}
        <p>{issue.message}</p>
      </li>)}
    </ul>}
    {conflicts.length > 0 && <SyncConflicts conflicts={conflicts} busy={busy || !config?.enabled} onMerge={onMerge} />}
    {issues.length === 0 && conflicts.length === 0 && <p>同步已恢复。</p>}
    {message && <p className="sync-recovery-status" role="status">{message}</p>}
    {copyStatus && <p className="sync-recovery-status" role="status">{copyStatus}</p>}
    <footer>
      {(issues.length > 0 || conflicts.length > 0) && <button type="button" onClick={() => void copy()}>复制诊断信息</button>}
      {backup && <button type="button" disabled={busy} onClick={onBackup}>导出本机备份</button>}
      {connection && <button type="button" className="sync-primary" disabled={busy} onClick={onReconnect}>打开连接设置</button>}
      {hasStatisticsIssue && <button type="button" className={hasLibraryIssue || connection ? undefined : 'sync-primary'}
        disabled={busy || Boolean(config && !config.enabled && !config.initialized)} onClick={() => onRetry(true)}>重试听歌统计</button>}
      {hasLibraryIssue && <button type="button" className={connection || conflicts.length ? undefined : 'sync-primary'} disabled={busy}
        onClick={() => onRetry(false)}>{config?.enabled ? needsPreview ? '刷新冲突' : '重试同步' : '重新检查'}</button>}
    </footer>
  </CollectionDialog>
}
