import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, LoaderCircle } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { commentChapterCandidates, commentId, commentRootId, flattenCommentThread, type CommentChapter } from '../../domain/commentChapters'
import type { BiliComment } from '../../domain/comments'
import { commandErrorMessage } from '../../services/desktopApi'
import { ChapterEditor } from './ChapterEditor'
import { commentReplyPageQuery } from './commentQuery'

export type CommentChapterImportSeed = {
  aid: number
  root: BiliComment
  replies: readonly BiliComment[]
  durationSeconds: number
  isCurrent: () => boolean
  onSave: (chapters: CommentChapter[]) => Promise<void>
}

export function CommentChapterImport({ seed, onCancel, onApplied }: { seed: CommentChapterImportSeed; onCancel: () => void; onApplied: () => void }) {
  const client = useQueryClient()
  const nextPage = useRef(1)
  const seenPages = useRef(new Map<string, number>())
  const replies = useRef<BiliComment[]>([...seed.replies])
  const runVersion = useRef(0)
  const back = useRef<HTMLButtonElement>(null)
  const [read, setRead] = useState(() => flattenCommentThread(seed.root, replies.current).length - 1)
  const [state, setState] = useState<'reading' | 'paused' | 'ready'>(seed.root.replyCount > 0 ? 'reading' : 'ready')
  const [issue, setIssue] = useState('')

  async function loadReplies() {
    const run = ++runVersion.current
    const isActive = () => run === runVersion.current && seed.isCurrent()
    if (!isActive()) return
    setState('reading')
    setIssue('')
    try {
      while (isActive()) {
        const page = nextPage.current
        const query = commentReplyPageQuery(seed.aid, commentRootId(seed.root), page)
        const result = await client.fetchQuery(query)
        if (!isActive()) return
        const signature = result.items.map(commentId).sort().join(',')
        const duplicatePage = signature && seenPages.current.has(signature) && seenPages.current.get(signature) !== page
        if (duplicatePage || (!result.isEnd && result.next <= page)) {
          await client.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: 'none' })
          throw new Error('回复页重复，请重试')
        }
        if (signature) seenPages.current.set(signature, page)
        replies.current.push(...result.items)
        setRead(flattenCommentThread(seed.root, replies.current).length - 1)
        if (result.isEnd) {
          setState('ready')
          return
        }
        nextPage.current = result.next
      }
    } catch (cause) {
      if (!isActive()) return
      setIssue(commandErrorMessage(cause))
      setState('paused')
    }
  }

  useLayoutEffect(() => { back.current?.focus({ preventScroll: true }) }, [])
  // Fetch serially after the user opens the editor, resuming at the failed page.
  useEffect(() => {
    if (seed.root.replyCount > 0) void loadReplies()
    return () => { runVersion.current++ }
  }, [])

  const candidates = state === 'ready'
    ? commentChapterCandidates(seed.root, replies.current, seed.durationSeconds)
    : []
  const editing = candidates.length > 0
  const title = editing ? '编辑章节' : '解析章节'

  return <div className="comments-page comments-chapter-page" aria-label={title}>
    <header className="comments-thread-header"><button ref={back} type="button" onClick={onCancel} aria-label="返回评论"><ArrowLeft aria-hidden="true" /></button>
      <div><h3>{title}</h3><small title={seed.root.userName}>{seed.root.userName} 的评论</small></div></header>
    {editing ? <ChapterEditor initialChapters={candidates} durationSeconds={seed.durationSeconds} sourceAuthor={seed.root.userName}
      onCancel={onCancel} isCurrent={seed.isCurrent} onSave={async chapters => {
        await seed.onSave(chapters)
        if (seed.isCurrent()) onApplied()
      }} /> : <div className="comment-chapter-status" aria-live="polite">
      {state === 'reading' ? <div className="comment-chapter-reading"><LoaderCircle className="spin" size={18} aria-hidden="true" />正在读取回复</div> : state === 'ready' ? '这条评论没有可用的章节' : <>
        {issue && <div role="alert">{issue}</div>}
        <button className="chapter-edit-cancel" type="button" onClick={() => void loadReplies()}>重试读取回复</button>
      </>}
      {state === 'reading' && read > 0 && <small>已读取 {read} 条回复</small>}
    </div>}
  </div>
}
