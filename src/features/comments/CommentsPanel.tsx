import { accountQueryKey } from '../../services/queryKeys'
import { CommentEmotes, useCommentEmotes } from './CommentEmotes'
import { CommentEditor, type CommentEditorHandle } from './CommentEditor'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronDown, Heart, ListTree, LoaderCircle, MessageCircle, Send, Smile, Keyboard, X } from 'lucide-react'
import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { LoadMore } from '../../shared/LoadMore'
import { usePanelPresence } from '../../shared/usePanelPresence'
import { usePanelReveal } from '../../shared/usePanelReveal'
import { commentQuery, commentReplyPageQuery } from './commentQuery'
import { CommentChapterImport, type CommentChapterImportSeed } from './CommentChapterImport'
import { CommentBody } from './CommentBody'
import { CommentsSurface } from './CommentsSurface'
import { accountEpoch } from '../../services/accountScope'
import { isMobile } from '../../services/platform'
import { commandErrorMessage, replyComment, setCommentLike } from '../../services/desktopApi'
import { commentId, commentRootId, isCommentChapterList, isCommentThreadChapterList, type CommentChapter } from '../../domain/commentChapters'
import type { BiliComment } from '../../domain/comments'
import { logicalPlaybackIdentity, usePlayerStore } from '../player/playerStore'

const drafts = new Map<string, { replying: BiliComment | null; message: string }>()
window.addEventListener('bilimusic-account-changing', () => drafts.clear())

type OptimisticLike = { liked: boolean; likeCount: number }

const Timeline = createContext<{ duration: number; seek: (seconds: number) => void } | undefined>(undefined)

export type ChaptersForComments = {
  durationSeconds: number
  existingChapters?: readonly CommentChapter[]
  isCurrent?: () => boolean
  onSave: (chapters: CommentChapter[]) => Promise<void>
}

const ChapterActions = createContext<{
  durationSeconds: number
  label: string
  open: (root: BiliComment, selected: BiliComment, trigger: HTMLButtonElement) => void
} | undefined>(undefined)

function CommentsPages({ threadOpen, children }: { threadOpen: boolean; children: ReactNode }) {
  const pages = useRef<HTMLDivElement>(null)
  usePanelReveal(pages, threadOpen)
  return <div className="comments-pages" ref={pages}>{children}</div>
}

export const CommentsPanel = memo(function CommentsPanel({ aid, trackId, open, onClose, video, chapters }: {
  open: boolean; aid: number; trackId: string; onClose: () => void; video?: HTMLElement | null; chapters?: ChaptersForComments
}) {
  const client = useQueryClient()
  const comments = useInfiniteQuery(commentQuery(aid))
  const [expanded, setExpanded] = useState<Record<number, BiliComment[]>>({})
  const [replyPages, setReplyPages] = useState<Record<number, number>>({})
  const [loadingReplies, setLoadingReplies] = useState<number | null>(null)
  const [likePending, setLikePending] = useState<Set<number>>(() => new Set())
  const likeRequests = useRef(new Set<number>())
  const [optimisticLikes, setOptimisticLikes] = useState<Record<number, OptimisticLike>>({})
  const [thread, setThread] = useState<BiliComment | null>(null)
  const [threadOpen, setThreadOpen] = useState(false)
  const threadPresent = usePanelPresence(threadOpen, 250)
  const threadBack = useRef<HTMLButtonElement>(null)
  const threadTrigger = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mainScroll = useRef(0)
  const replyRequest = useRef(new Set<number>())
  const [failedReplies, setFailedReplies] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (threadOpen) threadBack.current?.focus({ preventScroll: true })
    else if (threadTrigger.current) {
      const list = listRef.current
      const position = mainScroll.current
      if (list) list.scrollTop = position
      threadTrigger.current.focus({ preventScroll: true })
      threadTrigger.current = null
      // The sheet can still be shrinking when returning from replies. If the
      // taller viewport clamped the saved scroll offset, restore it once more.
      if (list && list.scrollTop < position) {
        const clamped = list.scrollTop
        const resize = list.closest('.comments-sheet')?.getAnimations().find(
          animation => 'transitionProperty' in animation && animation.transitionProperty === 'height',
        )
        if (resize) {
          let returning = true
          void resize.finished.then(() => {
            if (returning && list.isConnected && list.scrollTop === clamped) list.scrollTop = position
          }, () => undefined)
          return () => { returning = false }
        }
      }
    }
  }, [threadOpen])
  const closeThread = () => setThreadOpen(false)
  const scope = useRef(accountEpoch()).current
  const duration = usePlayerStore(state => state.current?.id === trackId ? state.durationSeconds : 0)
  const [chapterImport, setChapterImport] = useState<CommentChapterImportSeed | null>(null)
  const chapterTrigger = useRef<HTMLButtonElement | null>(null)
  const chapterVersion = useRef(0)
  const visible = useRef(open)
  visible.current = open
  const closeChapterImport = () => { ++chapterVersion.current; setChapterImport(null) }
  useLayoutEffect(() => {
    if (!chapterImport && chapterTrigger.current) {
      if (open) chapterTrigger.current.focus({ preventScroll: true })
      chapterTrigger.current = null
    }
  }, [chapterImport, open])
  useEffect(() => {
    if (chapterImport && (!open || !chapters || !chapterImport.isCurrent())) closeChapterImport()
  }, [chapters, chapterImport, duration, open])
  useEffect(() => () => { ++chapterVersion.current }, [])

  const chapterActions = chapters && chapters.durationSeconds > 0 ? {
    durationSeconds: chapters.durationSeconds,
    label: chapters.existingChapters?.length ? '更新章节' : '解析章节',
    open(root: BiliComment, selected: BiliComment, trigger: HTMLButtonElement) {
      const version = ++chapterVersion.current
      const playback = logicalPlaybackIdentity()
      const isCurrent = () => {
        const active = usePlayerStore.getState().current
        return visible.current && chapterVersion.current === version && scope === accountEpoch() &&
          active?.id === trackId && active.source.aid === aid && playback === logicalPlaybackIdentity() &&
          chapters.isCurrent?.() !== false
      }
      if (!isCurrent()) return
      chapterTrigger.current = trigger
      const loaded = expanded[root.id] ?? []
      setChapterImport({ aid, root, replies: [...loaded, selected], durationSeconds: chapters.durationSeconds, isCurrent, onSave: chapters.onSave })
    },
  } : undefined
  const timeline = useMemo(() => ({
    duration,
    seek: (seconds: number) => {
      const player = usePlayerStore.getState()
      if (scope === accountEpoch() && player.current?.id === trackId && player.current.source.aid === aid && seconds >= 0 && seconds < player.durationSeconds) player.seek(seconds)
    },
  }), [aid, duration, scope, trackId])
  const draftKey = `${scope}:${aid}`
  const [replying, setReplying] = useState<BiliComment | null>(() => drafts.get(draftKey)?.replying ?? null)
  const [message, setMessage] = useState(() => drafts.get(draftKey)?.message ?? '')
  const editor = useRef<CommentEditorHandle>(null)
  const emotePackages=useCommentEmotes()
  const emoteImages=useMemo(()=>{
    const images:Record<string,string>={...replying?.emotes}
    for(const pack of emotePackages.data??[])for(const emote of pack.emotes)if(emote.url&&!Object.hasOwn(images,emote.text))images[emote.text]=emote.url
    return images
  },[emotePackages.data,replying?.emotes])
  const [emotesOpen, setEmotesOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const targetDrafts = useRef(new Map<number, string>())
  const draft = useRef({ replying, message })
  draft.current = { replying, message }
  useEffect(() => () => {
    if (scope !== accountEpoch()) return
    if (draft.current.message) { if (drafts.size >= 30) drafts.delete(drafts.keys().next().value!); drafts.set(draftKey, draft.current) }
    else drafts.delete(draftKey)
  }, [draftKey, scope])
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  const shown = (comment: BiliComment): BiliComment => optimisticLikes[comment.id] ? { ...comment, ...optimisticLikes[comment.id] } : comment
  const loadReplies = async (comment: BiliComment, page: number) => {
    if (replyRequest.current.has(comment.id)) return
    replyRequest.current.add(comment.id)
    setFailedReplies(null)
    setLoadingReplies(comment.id)
    try {
      const result = await client.fetchQuery(commentReplyPageQuery(aid, commentRootId(comment), page))
      if (scope !== accountEpoch()) return
      setExpanded(value => ({ ...value, [comment.id]: [...new Map([...(page === 1 ? [] : value[comment.id] || []), ...result.items].map(reply => [commentId(reply), reply])).values()] }))
      setReplyPages(value => ({ ...value, [comment.id]: result.isEnd ? -1 : result.next - 1 }))
    }
    catch (cause) { if (scope === accountEpoch()) { setFailedReplies(comment.id); setError(commandErrorMessage(cause)) } }
    finally { replyRequest.current.delete(comment.id); setLoadingReplies(null) }
  }
  const expand = async (comment: BiliComment, trigger: HTMLButtonElement) => {
    if (isMobile) {
      mainScroll.current = listRef.current?.scrollTop ?? 0
      threadTrigger.current = trigger
      setThread(comment)
      setThreadOpen(true)
      if (!expanded[comment.id]) await loadReplies(comment, 1)
      return
    }
    if (expanded[comment.id]) { setExpanded((value) => { const next = { ...value }; delete next[comment.id]; return next }); return }
    await loadReplies(comment, 1)
  }
  const like = async (comment: BiliComment) => {
    if (likeRequests.current.has(comment.id)) return
    likeRequests.current.add(comment.id)
    const current = shown(comment)
    const next = { liked: !current.liked, likeCount: Math.max(0, current.likeCount + (current.liked ? -1 : 1)) }
    setOptimisticLikes(value => ({ ...value, [comment.id]: next }))
    setLikePending(value => new Set(value).add(comment.id))
    try {
      await setCommentLike(aid, comment.id, next.liked)
      // Keep the acknowledged value for this panel's lifetime: the read API can
      // lag behind the write API, including for replies not in the query cache.
    } catch (cause) {
      setOptimisticLikes(value => ({ ...value, [comment.id]: { liked: current.liked, likeCount: current.likeCount } }))
      setError(`点赞失败，已恢复原状态：${commandErrorMessage(cause)}`)
    } finally {
      likeRequests.current.delete(comment.id)
      setLikePending(value => { const copy = new Set(value); copy.delete(comment.id); return copy })
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!message.trim() || sending || scope !== accountEpoch()) return
    setSending(true); setError('')
    try {
      const target = replying
      await replyComment(aid, message, target?.rootId, target?.id)
      if (scope !== accountEpoch()) return
      targetDrafts.current.delete(target?.id ?? 0)
      setMessage(''); setReplying(null); setEmotesOpen(false); setNotice('评论已发送')
      drafts.delete(draftKey)
      if (target) {
        const query = commentReplyPageQuery(aid, commentRootId(target), 1)
        await client.invalidateQueries({ queryKey: accountQueryKey('comment-replies-page', aid, commentRootId(target)), refetchType: 'none' })
        const fresh = await client.fetchQuery(query).then(page => page.items, () => [])
        if (scope !== accountEpoch()) return
        setExpanded(value => value[target.rootId] ? { ...value, [target.rootId]: [...new Map([...value[target.rootId], ...fresh].map(item => [commentId(item),item])).values()] } : value)
      }
      await Promise.all([client.invalidateQueries({ queryKey: accountQueryKey('comments', aid) })])
    }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setSending(false) }
  }
  const changeTarget = (target: BiliComment | null) => {
    if (sending) return
    targetDrafts.current.set(replying?.id ?? 0, message)
    setReplying(target); setMessage(targetDrafts.current.get(target?.id ?? 0) ?? '')
    setNotice(''); setError(''); setEmotesOpen(false)
    requestAnimationFrame(()=>editor.current?.focus())
  }
  const beginReply = (target: BiliComment) => changeTarget(target)
  const insertEmote = (token: string) => {
    if(!editor.current?.insert(token))setError('回复内容不能超过 1000 个字符')
    else {setError('');setNotice('')}
  }
  const items = [...new Map(comments.data?.pages.flatMap((page) => page.items).map((comment) => [commentId(comment), comment]) || []).values()]
  const threadReplies = thread ? expanded[thread.id] || [] : []

  return <Timeline.Provider value={timeline}><ChapterActions.Provider value={chapterActions}><CommentsSurface open={open} chapterEditor={isMobile && Boolean(chapterImport)}
    onBackFromComposer={chapterImport ? undefined : emotesOpen ? () => setEmotesOpen(false) : replying ? () => changeTarget(null) : undefined}
    video={video} onClose={onClose} onBackFromThread={chapterImport ? closeChapterImport : threadOpen ? closeThread : undefined}>
    <CommentsPages threadOpen={threadOpen}>
    {threadPresent && thread && <div className="comments-page comments-thread" key={commentId(thread)} inert={!threadOpen || Boolean(chapterImport)}>
      <header className="comments-thread-header"><button ref={threadBack} onClick={closeThread} aria-label="返回评论列表"><ArrowLeft /></button><div><strong>评论回复</strong><small>{thread.replyCount} 条回复</small></div></header>
      <div className="comments-scroll comments-thread-scroll">
        <CommentRow comment={shown(thread)} chapterReplies={threadReplies} hideExpand onExpand={() => undefined} onReply={beginReply} onLike={(target) => void like(target)} pending={likePending.has(thread.id)} />
        <div className="comments-thread-divider">全部回复</div>
        {threadReplies.map(reply => <CommentRow key={commentId(reply)} comment={shown(reply)} chapterRoot={thread} nested hideExpand onExpand={() => undefined} onReply={beginReply} onLike={(target) => void like(target)} pending={likePending.has(reply.id)} />)}
        {loadingReplies === thread.id && <div className="comments-status compact"><LoaderCircle className="spin" />正在加载回复</div>}
        {failedReplies === thread.id && !replyPages[thread.id] && <button className="load-more" onClick={() => void loadReplies(thread, 1)}>重试加载回复</button>}
        {replyPages[thread.id] > 0 && threadReplies.length < thread.replyCount && <LoadMore busy={loadingReplies === thread.id} automatic={threadOpen && failedReplies !== thread.id} onLoad={() => void loadReplies(thread, replyPages[thread.id] + 1)} label={failedReplies === thread.id ? '重试加载回复' : '加载更多回复'}/>}
      </div>
    </div>}
    <div className="comments-page comments-index" inert={threadOpen || Boolean(chapterImport)}>
      <header><div><span className="eyebrow">COMMENTS</span><h3>评论 {comments.data ? `(${comments.data.pages[0].total})` : ''}</h3></div><button onClick={onClose} aria-label="关闭评论">{isMobile ? <ChevronDown /> : <X />}</button></header>
      <div className="comments-scroll" ref={listRef}>{comments.isLoading ? <div className="comments-status"><LoaderCircle className="spin" />加载评论</div> : <>{items.map((source) => {
        const comment = shown(source)
        const inline = comment.replyCount === 1
        return <div key={commentId(comment)}><CommentRow comment={comment} replies={isMobile || inline ? undefined : expanded[comment.id]?.map(shown)} chapterReplies={expanded[comment.id]} hideExpand={inline}
          inlineReply={inline ? <InlineReply aid={aid} root={comment}>{reply => <CommentRow comment={shown(reply)} chapterRoot={comment} nested hideExpand
            onExpand={() => undefined} onReply={beginReply} onLike={target => void like(target)} pending={likePending.has(reply.id)}/>}</InlineReply> : undefined}
          onExpand={trigger => void expand(comment, trigger)} onReply={beginReply} onLike={(target) => void like(target)} pending={likePending.has(comment.id)} />{!isMobile && (loadingReplies === comment.id ? <small>正在加载回复…</small> : expanded[comment.id] && replyPages[comment.id] > 0 && expanded[comment.id].length < comment.replyCount && <LoadMore busy={false} automatic={failedReplies !== comment.id} onLoad={() => void loadReplies(comment, replyPages[comment.id] + 1)} label={failedReplies === comment.id ? '重试加载回复' : '加载更多回复'}/>)}</div>
      })}{!items.length && !comments.isError && <div className="comments-status">还没有评论</div>}{comments.hasNextPage && <LoadMore busy={comments.isFetchingNextPage} automatic={!threadOpen && !comments.isFetchNextPageError} onLoad={() => void comments.fetchNextPage()} label={comments.isFetchNextPageError ? '重试加载评论' : '加载更多评论'}/>}{comments.isError && !comments.isFetchNextPageError && <button className="load-more" onClick={() => void comments.refetch()}>{commandErrorMessage(comments.error)} · 重试</button>}</>}</div>
    </div>
    {chapterImport && <CommentChapterImport seed={chapterImport} onCancel={closeChapterImport} onApplied={() => { closeChapterImport(); setNotice('章节已保存') }} />}
    </CommentsPages>
    {!chapterImport && <form className="comment-compose" onSubmit={submit}>
      {replying && <div className="comment-reply-context"><div><strong>回复 @{replying.userName}</strong><span><CommentBody body={replying.message} emotes={replying.emotes}/></span></div><button type="button" aria-label="取消回复" disabled={sending} onClick={() => changeTarget(null)}><X size={17}/></button></div>}
      <CommentEditor key={replying?.id??0} ref={editor} disabled={sending} value={message} emotes={emoteImages} label={replying ? `回复 ${replying.userName}` : '评论内容'} onFocus={() => setEmotesOpen(false)} onChange={value=>{setMessage(value);setNotice('')}} placeholder={replying ? `回复 @${replying.userName}` : '友善地说点什么…'}/>
      <button type="button" className="comment-emote-toggle" aria-label={emotesOpen ? '打开键盘' : '选择表情'} aria-expanded={emotesOpen} disabled={sending} onPointerDown={event => event.preventDefault()} onClick={() => { if (emotesOpen) { setEmotesOpen(false); editor.current?.focus() } else { editor.current?.blur(); setEmotesOpen(true) } }}>{emotesOpen ? <Keyboard size={21}/> : <Smile size={21}/>}</button>
      <button className="comment-send" disabled={sending || !message.trim() || Array.from(message).length > 1000}>{sending ? <LoaderCircle className="spin" /> : <Send />}发送</button>
      {(error || notice) && <small role={error ? 'alert' : 'status'}>{error || notice}</small>}
      {emotesOpen && <CommentEmotes onChoose={insertEmote}/>}
    </form>}
  </CommentsSurface></ChapterActions.Provider></Timeline.Provider>
})

function InlineReply({ aid, root, children }: { aid: number; root: BiliComment; children: (reply: BiliComment) => ReactNode }) {
  const embedded = root.replies[0]
  const holder = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (embedded || visible || !holder.current) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setVisible(true)
    }, { root: holder.current.closest('.comments-scroll'), rootMargin: '100px' })
    observer.observe(holder.current)
    return () => observer.disconnect()
  }, [embedded, visible])
  const query = useQuery({
    ...commentReplyPageQuery(aid, commentRootId(root), 1),
    enabled: !embedded && visible,
  })
  const reply = embedded || query.data?.items[0]
  return <div className="inline-comment-reply" ref={holder}>
    {reply ? children(reply) : query.isError ? <button className="load-more" onClick={() => void query.refetch()}>重试加载回复</button> : null}
  </div>
}

function splitReply(message: string) {
  const match = message.match(/^(?:回复\s*)?@([^\s:：]+)\s*[:：]\s*([\s\S]*)$/)
  return match ? { target: match[1], body: match[2] } : { body: message }
}

function CommentRow({ comment, replies, chapterRoot, chapterReplies, inlineReply, onExpand, onReply, onLike, nested = false, hideExpand = false, pending = false }: { comment: BiliComment; replies?: BiliComment[]; chapterRoot?: BiliComment; chapterReplies?: BiliComment[]; inlineReply?: ReactNode; onExpand: (trigger: HTMLButtonElement) => void; onReply: (comment: BiliComment) => void; onLike: (comment: BiliComment) => void; nested?: boolean; hideExpand?: boolean; pending?: boolean }) {
  const content = splitReply(comment.message)
  const timeline = useContext(Timeline)
  const chapters = useContext(ChapterActions)
  const chapterDuration = chapters?.durationSeconds ?? 0
  const hasChapterList = useMemo(() => {
    if (!chapterDuration) return false
    if (chapterRoot) return isCommentChapterList(comment.message, chapterDuration)
    return isCommentThreadChapterList(comment, chapterReplies ?? [], chapterDuration)
  }, [chapterDuration, chapterReplies, chapterRoot, comment])
  const bodyId = useId()
  const body = useRef<HTMLParagraphElement>(null)
  const [full, setFull] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const foldScroll = useRef<{ list: HTMLElement; top: number } | undefined>(undefined)
  const toggleFull = () => {
    const list = body.current?.closest<HTMLElement>('.comments-scroll')
    if (list) foldScroll.current = { list, top: list.scrollTop }
    setFull(value => !value)
  }
  useLayoutEffect(() => {
    const anchor = foldScroll.current
    if (anchor) anchor.list.scrollTop = anchor.top
    foldScroll.current = undefined
  }, [full])
  useLayoutEffect(() => {
    const node = body.current
    if (!node) return
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight)
      setOverflow(node.scrollHeight > lineHeight * 6 + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    node.addEventListener('load', measure, true)
    return () => { observer.disconnect(); node.removeEventListener('load', measure, true) }
  }, [comment.message, full, timeline?.duration])
  const press = useRef<{x:number;y:number;at:number;moved:boolean} | null>(null)
  const replyFromBody = () => {
    if (window.getSelection()?.toString() || press.current?.moved || press.current && performance.now() - press.current.at > 450) return
    onReply(comment)
  }
  return <article className={nested ? 'comment-row nested' : 'comment-row'}>
    <img src={comment.avatarUrl} alt="" loading="lazy" />
    <div>
      <header>
        <div className="comment-row-meta">
          <strong>{comment.userName}</strong>
          <small>{new Date(comment.createdAt * 1000).toLocaleDateString()}</small>
        </div>
        {chapters && hasChapterList && <button type="button" className="comment-chapters-action"
          onClick={event => chapters.open(chapterRoot ?? comment, comment, event.currentTarget)}>
          <ListTree size={16} aria-hidden="true" />{chapters.label}
        </button>}
      </header>
      <p ref={body} id={bodyId} className="comment-body-reply" data-full={full || undefined} onFocusCapture={event => {
        const target = event.target.getBoundingClientRect()
        if (overflow && target.bottom > event.currentTarget.getBoundingClientRect().bottom) setFull(true)
      }} onPointerDown={event => { press.current = {x:event.clientX,y:event.clientY,at:performance.now(),moved:false} }} onPointerMove={event => { if (press.current && Math.hypot(event.clientX-press.current.x,event.clientY-press.current.y)>8) press.current.moved=true }} onClick={replyFromBody}>
        {content.target && <><span className="reply-prefix">回复</span> <span className="reply-target">@{content.target}</span><span className="reply-colon">：</span></>}
        <CommentBody body={content.body} emotes={comment.emotes} timeline={timeline}/>
      </p>
      {overflow && <button type="button" className="comment-fold-toggle" aria-controls={bodyId} aria-expanded={full} onMouseDown={event => event.preventDefault()} onClick={toggleFull}>{full ? '收起全文' : '展开全文'}</button>}
      <footer>
        <button aria-busy={pending} onClick={() => onLike(comment)} className={comment.liked ? 'liked' : ''}><Heart fill={comment.liked ? 'currentColor' : 'none'} />{comment.likeCount || ''}</button>
        <button onClick={() => onReply(comment)}><MessageCircle />回复</button>
        {!hideExpand && !nested && comment.replyCount > 0 && <button onClick={event => onExpand(event.currentTarget)}>{replies ? '收起回复' : `查看 ${comment.replyCount} 条回复`}<ChevronDown /></button>}
      </footer>
      {inlineReply}
      {replies && <div className="nested-comments">
        {replies.map(reply => <CommentRow key={commentId(reply)} comment={reply} chapterRoot={chapterRoot ?? comment} nested hideExpand onExpand={() => undefined} onReply={onReply} onLike={onLike} />)}
        <button className="collapse-replies" onClick={event => onExpand(event.currentTarget)}>收起回复</button>
      </div>}
    </div>
  </article>
}
