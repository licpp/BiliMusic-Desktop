import { useEffect, useId, useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { readTrackedFeedback, readTrackedFeedbackStatus, type FeedbackStatus, type TrackedFeedback } from '../../services/feedback'
import { commandErrorMessage } from '../../services/userErrors'

const pageSize = 8
const stages = [
  { status: 'new', label: '未开始' },
  { status: 'in_progress', label: '进行中' },
  { status: 'resolved', label: '已完成' },
] as const
const statusLabels = { new: '未开始', in_progress: '进行中', resolved: '已完成', closed: '已关闭' }
type Detail = { status: FeedbackStatus } | { error: string }

const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })

function FeedbackDate({ date }: { date: string }) {
  const parsed = new Date(date)
  return Number.isFinite(parsed.getTime()) ? <time dateTime={date}>{dateFormat.format(parsed)}</time> : null
}

export function FeedbackHistory({ accountSession, initiallyExpanded }: { accountSession: string; initiallyExpanded?: string }) {
  const [entries, setEntries] = useState<TrackedFeedback[]>([])
  const [details, setDetails] = useState<Record<string, Detail>>({})
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [page, setPage] = useState(0)
  const [revision, reload] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const epoch = accountEpoch()
    const isCurrent = () => active && accountEpoch() === epoch
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const items = await readTrackedFeedback(accountSession)
        if (!isCurrent()) return
        setEntries(items)
        const visible = items.slice(page * pageSize, (page + 1) * pageSize)
        for (let index = 0; index < visible.length && isCurrent(); index += 3) {
          const batch = await Promise.all(visible.slice(index, index + 3).map(async item => {
            try {
              return [item.localId, { status: await readTrackedFeedbackStatus(accountSession, item.localId) }] as const
            } catch (cause) {
              const missing = typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'feedback_not_found'
              const error = missing ? (item.id ? '该反馈已不可查询' : '等待提交回执') : commandErrorMessage(cause, '暂时无法刷新进度')
              return [item.localId, { error }] as const
            }
          }))
          if (isCurrent()) setDetails(current => ({ ...current, ...Object.fromEntries(batch) }))
        }
      } catch (cause) {
        if (isCurrent()) setError(commandErrorMessage(cause, '暂时无法打开反馈记录'))
      } finally {
        if (isCurrent()) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [accountSession, page, revision])

  const toggle = (item: TrackedFeedback) => {
    const open = expanded === item.localId || (!!item.id && expanded === item.id)
    setExpanded(open ? undefined : item.localId)
  }
  const visible = entries.slice(page * pageSize, (page + 1) * pageSize)

  return <section className="feedback-history" aria-label="我的反馈">
    <div className="feedback-history-tools">
      <span>本机提交的反馈</span>
      <button type="button" className="collection-flat-button" onClick={() => reload(value => value + 1)} disabled={loading}>
        <RefreshCw size={15} className={loading ? 'spin' : undefined}/>刷新
      </button>
    </div>
    {error && <p className="feedback-history-empty" role="alert">{error}</p>}
    {!error && !entries.length && <p className="feedback-history-empty" role="status">{loading ? '正在读取反馈…' : '暂无可查看的反馈'}</p>}
    <div className="feedback-history-list">
      {visible.map(item => <FeedbackHistoryRow key={item.localId} item={item} detail={details[item.localId]}
        open={expanded === item.localId || (!!item.id && expanded === item.id)} onToggle={() => toggle(item)}/>)}
    </div>
    {entries.length > pageSize && <div className="feedback-history-pages">
      <button type="button" className="collection-flat-button" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" className="collection-flat-button" disabled={(page + 1) * pageSize >= entries.length || loading} onClick={() => setPage(value => value + 1)}>下一页</button>
    </div>}
  </section>
}

function FeedbackHistoryRow({ item, detail, open, onToggle }: { item: TrackedFeedback; detail?: Detail; open: boolean; onToggle: () => void }) {
  const id = useId()
  const status = detail && 'status' in detail ? detail.status : undefined
  const notice = detail && 'error' in detail ? detail.error : '正在查询进度…'

  return <article className="feedback-history-item">
    <button type="button" className="feedback-history-item-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
      <span className="feedback-history-item-title"><strong>{item.title}</strong><FeedbackDate date={item.createdAt}/></span>
      <span className="feedback-status-pill" data-status={status?.status}>{status ? statusLabels[status.status] : notice}</span>
      <ChevronDown size={17} aria-hidden="true"/>
    </button>
    {open && <div id={id} className="feedback-history-detail">
      {status ? <>
        {status.status === 'closed'
          ? <div className="feedback-closed"><strong>已关闭</strong>{status.statusChangedAt && <FeedbackDate date={status.statusChangedAt}/>}</div>
          : <ol className="feedback-progress" aria-label="处理进度">{stages.map((stage, index) => {
            const current = stages.findIndex(step => step.status === status.status)
            return <li key={stage.status} data-reached={index <= current || undefined} aria-current={index === current ? 'step' : undefined}>
              <span>{stage.label}</span>{stage.status === 'resolved' && status.completedAt && <FeedbackDate date={status.completedAt}/>}
            </li>
          })}</ol>}
        {!!status.replies.length && <div className="feedback-replies">
          <h3>处理回复</h3>
          {status.replies.map(reply => <div className="feedback-reply" key={reply.id}><FeedbackDate date={reply.createdAt}/><p>{reply.body}</p></div>)}
        </div>}
      </> : <p className="feedback-history-empty" role="status">{notice}</p>}
    </div>}
  </article>
}
