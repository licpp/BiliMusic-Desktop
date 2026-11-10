import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronDown, Heart, LoaderCircle, MessageCircle, Send, X } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { LoadMore } from '../../shared/LoadMore'
import { commentQuery } from './commentQuery'
import { CommentBody } from './CommentBody'
import { CommentsSurface } from './CommentsSurface'
import { accountEpoch } from '../../services/accountScope'
import { isMobile } from '../../services/platform'
import { commandErrorMessage, getCommentReplies, replyComment, setCommentLike, type BiliComment } from '../../services/desktopApi'

type OptimisticLike = { liked: boolean; likeCount: number }

export const CommentsPanel = memo(function CommentsPanel({ aid, onClose, video }: { aid: number; onClose: () => void; video?: HTMLElement | null }) {
  const client = useQueryClient()
  const comments = useInfiniteQuery(commentQuery(aid))
  const [expanded, setExpanded] = useState<Record<number, BiliComment[]>>({})
  const [replyPages, setReplyPages] = useState<Record<number, number>>({})
  const [loadingReplies, setLoadingReplies] = useState<number | null>(null)
  const [likePending, setLikePending] = useState<Set<number>>(() => new Set())
  const likeRequests = useRef(new Set<number>())
  const [optimisticLikes, setOptimisticLikes] = useState<Record<number, OptimisticLike>>({})
  const [thread, setThread] = useState<BiliComment | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mainScroll = useRef(0)
  const replyRequest = useRef(new Set<number>())
  const [failedReplies, setFailedReplies] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!thread && listRef.current) listRef.current.scrollTop = mainScroll.current
  }, [thread])
  const [replying, setReplying] = useState<BiliComment | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  const shown = (comment: BiliComment): BiliComment => optimisticLikes[comment.id] ? { ...comment, ...optimisticLikes[comment.id] } : comment
  const loadReplies = async (comment: BiliComment, page: number) => {
    if (replyRequest.current.has(comment.id)) return
    replyRequest.current.add(comment.id)
    setFailedReplies(null)
    setLoadingReplies(comment.id)
    try { const replies = await getCommentReplies(aid, comment.rootId, page); setExpanded((value) => ({ ...value, [comment.id]: [...new Map([...(page === 1 ? [] : value[comment.id] || []), ...replies].map((reply) => [reply.id, reply])).values()] })); setReplyPages((value) => ({ ...value, [comment.id]: replies.length < 20 ? -1 : page })) }
    catch (cause) { setFailedReplies(comment.id); setError(commandErrorMessage(cause)) }
    finally { replyRequest.current.delete(comment.id); setLoadingReplies(null) }
  }
  const expand = async (comment: BiliComment) => {
    if (isMobile) { mainScroll.current = listRef.current?.scrollTop ?? 0; setThread(comment); if (!expanded[comment.id]) await loadReplies(comment, 1); return }
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
    event.preventDefault(); if (!message.trim()) return
    setSending(true); setError('')
    try { await replyComment(aid, message, replying?.rootId, replying?.id); setMessage(''); setReplying(null); setExpanded({}); setThread(null); await Promise.all([client.invalidateQueries({ queryKey: ['comments', aid] }), client.invalidateQueries({ queryKey: ['comment-inline-reply', aid] })]) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setSending(false) }
  }
  const beginReply = (target: BiliComment) => { setReplying(target); setMessage('') }
  const items = [...new Map(comments.data?.pages.flatMap((page) => page.items).map((comment) => [comment.id, comment]) || []).values()]
  const threadReplies = thread ? expanded[thread.id] || [] : []

  return <CommentsSurface video={video} onClose={onClose} onBackFromThread={thread ? () => setThread(null) : undefined}>
    {thread ? <>
      <header className="comments-thread-header"><button onClick={() => setThread(null)} aria-label="返回评论列表"><ArrowLeft /></button><div><strong>评论回复</strong><small>{thread.replyCount} 条回复</small></div></header>
      <div className="comments-scroll comments-thread-scroll">
        <CommentRow comment={shown(thread)} hideExpand onExpand={() => undefined} onReply={beginReply} onLike={(target) => void like(target)} pending={likePending.has(thread.id)} />
        <div className="comments-thread-divider">全部回复</div>
        {threadReplies.map(reply => <CommentRow key={reply.id} comment={shown(reply)} nested hideExpand onExpand={() => undefined} onReply={beginReply} onLike={(target) => void like(target)} pending={likePending.has(reply.id)} />)}
        {loadingReplies === thread.id && <div className="comments-status compact"><LoaderCircle className="spin" />正在加载回复</div>}
        {failedReplies === thread.id && !replyPages[thread.id] && <button className="load-more" onClick={() => void loadReplies(thread, 1)}>重试加载回复</button>}
        {replyPages[thread.id] > 0 && threadReplies.length < thread.replyCount && <LoadMore busy={loadingReplies === thread.id} automatic={failedReplies !== thread.id} onLoad={() => void loadReplies(thread, replyPages[thread.id] + 1)} label={failedReplies === thread.id ? '重试加载回复' : '加载更多回复'}/>}
      </div>
    </> : <>
      <header><div><span className="eyebrow">COMMENTS</span><h3>评论 {comments.data ? `(${comments.data.pages[0].total})` : ''}</h3></div><button onClick={onClose} aria-label="关闭评论">{isMobile ? <ChevronDown /> : <X />}</button></header>
      <div className="comments-scroll" ref={listRef}>{comments.isLoading ? <div className="comments-status"><LoaderCircle className="spin" />加载评论</div> : <>{items.map((source) => {
        const comment = shown(source)
        const inline = comment.replyCount === 1
        return <div key={comment.id}><CommentRow comment={comment} replies={isMobile || inline ? undefined : expanded[comment.id]?.map(shown)} hideExpand={inline}
          inlineReply={inline ? <InlineReply aid={aid} root={comment}>{reply => <CommentRow comment={shown(reply)} nested hideExpand
            onExpand={() => undefined} onReply={beginReply} onLike={target => void like(target)} pending={likePending.has(reply.id)}/>}</InlineReply> : undefined}
          onExpand={() => void expand(comment)} onReply={beginReply} onLike={(target) => void like(target)} pending={likePending.has(comment.id)} />{loadingReplies === comment.id ? <small>正在加载回复…</small> : !isMobile && expanded[comment.id] && replyPages[comment.id] > 0 && expanded[comment.id].length < comment.replyCount && <LoadMore busy={false} automatic={failedReplies !== comment.id} onLoad={() => void loadReplies(comment, replyPages[comment.id] + 1)} label={failedReplies === comment.id ? '重试加载回复' : '加载更多回复'}/>}</div>
      })}{!items.length && !comments.isError && <div className="comments-status">还没有评论</div>}{comments.hasNextPage && <LoadMore busy={comments.isFetchingNextPage} automatic={!comments.isFetchNextPageError} onLoad={() => void comments.fetchNextPage()} label={comments.isFetchNextPageError ? '重试加载评论' : '加载更多评论'}/>}{comments.isError && !comments.isFetchNextPageError && <button className="load-more" onClick={() => void comments.refetch()}>{commandErrorMessage(comments.error)} · 重试</button>}</>}</div>
    </>}
    <form className="comment-compose" onSubmit={submit}>{replying && <div><span>回复 <b>@{replying.userName}</b></span><button type="button" onClick={() => { setReplying(null); setMessage('') }}>取消</button></div>}<textarea maxLength={1000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={replying ? `回复 @${replying.userName}` : '友善地说点什么…'} />{error && <small>{error}</small>}<button disabled={sending || !message.trim()}>{sending ? <LoaderCircle className="spin" /> : <Send />}发送</button></form>
  </CommentsSurface>
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
    queryKey: ['comment-inline-reply', aid, accountEpoch(), root.rootId],
    queryFn: () => getCommentReplies(aid, root.rootId, 1),
    enabled: !embedded && visible,
    staleTime: 60_000,
    retry: false,
  })
  const reply = embedded || query.data?.[0]
  return <div className="inline-comment-reply" ref={holder}>
    {reply ? children(reply) : query.isError ? <button className="load-more" onClick={() => void query.refetch()}>重试加载回复</button> : null}
  </div>
}

function splitReply(message: string) {
  const match = message.match(/^(?:回复\s*)?@([^\s:：]+)\s*[:：]\s*([\s\S]*)$/)
  return match ? { target: match[1], body: match[2] } : { body: message }
}

function CommentRow({ comment, replies, inlineReply, onExpand, onReply, onLike, nested = false, hideExpand = false, pending = false }: { comment: BiliComment; replies?: BiliComment[]; inlineReply?: ReactNode; onExpand: () => void; onReply: (comment: BiliComment) => void; onLike: (comment: BiliComment) => void; nested?: boolean; hideExpand?: boolean; pending?: boolean }) {
  const content = splitReply(comment.message)
  return <article className={nested ? 'comment-row nested' : 'comment-row'}><img src={comment.avatarUrl} alt="" loading="lazy" /><div><header><strong>{comment.userName}</strong><small>{new Date(comment.createdAt * 1000).toLocaleDateString()}</small></header><p>{content.target && <><span className="reply-prefix">回复</span> <button className="reply-target" onClick={() => onReply(comment)}>@{content.target}</button><span className="reply-colon">：</span></>}<CommentBody body={content.body} emotes={comment.emotes}/></p><footer><button aria-busy={pending} onClick={() => onLike(comment)} className={comment.liked ? 'liked' : ''}><Heart fill={comment.liked ? 'currentColor' : 'none'} />{comment.likeCount || ''}</button><button onClick={() => onReply(comment)}><MessageCircle />回复</button>{!hideExpand && !nested && comment.replyCount > 0 && <button onClick={onExpand}>{replies ? '收起回复' : `查看 ${comment.replyCount} 条回复`}<ChevronDown /></button>}</footer>{inlineReply}{replies && <div className="nested-comments">{replies.map((reply) => <CommentRow key={reply.id} comment={reply} nested hideExpand onExpand={() => undefined} onReply={onReply} onLike={onLike} />)}<button className="collapse-replies" onClick={onExpand}>收起回复</button></div>}</div></article>
}
