import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronDown, Heart, LoaderCircle, MessageCircle, Send, X } from 'lucide-react'
import { memo, useRef, useState, type FormEvent } from 'react'
import { CommentsSurface } from './CommentsSurface'
import { isIOS } from '../../services/platform'
import { commandErrorMessage, getCommentReplies, getComments, replyComment, setCommentLike, type BiliComment } from '../../services/desktopApi'

type OptimisticLike = { liked: boolean; likeCount: number }

export const CommentsPanel = memo(function CommentsPanel({ aid, onClose }: { aid: number; onClose: () => void }) {
  const client = useQueryClient()
  const comments = useInfiniteQuery({ queryKey: ['comments', aid], initialPageParam: 1, queryFn: ({ pageParam }) => getComments(aid, pageParam), getNextPageParam: (last) => last.isEnd ? undefined : last.next })
  const [expanded, setExpanded] = useState<Record<number, BiliComment[]>>({})
  const [replyPages, setReplyPages] = useState<Record<number, number>>({})
  const [loadingReplies, setLoadingReplies] = useState<number | null>(null)
  const [likePending, setLikePending] = useState<Set<number>>(() => new Set())
  const likeRequests = useRef(new Set<number>())
  const [optimisticLikes, setOptimisticLikes] = useState<Record<number, OptimisticLike>>({})
  const [thread, setThread] = useState<BiliComment | null>(null)
  const [replying, setReplying] = useState<BiliComment | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  const shown = (comment: BiliComment): BiliComment => optimisticLikes[comment.id] ? { ...comment, ...optimisticLikes[comment.id] } : comment
  const loadReplies = async (comment: BiliComment, page: number) => {
    setLoadingReplies(comment.id)
    try { const replies = await getCommentReplies(aid, comment.rootId, page); setExpanded((value) => ({ ...value, [comment.id]: [...new Map([...(page === 1 ? [] : value[comment.id] || []), ...replies].map((reply) => [reply.id, reply])).values()] })); setReplyPages((value) => ({ ...value, [comment.id]: replies.length < 20 ? -1 : page })) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setLoadingReplies(null) }
  }
  const expand = async (comment: BiliComment) => {
    if (isIOS) { setThread(comment); if (!expanded[comment.id]) await loadReplies(comment, 1); return }
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
    try { await replyComment(aid, message, replying?.rootId, replying?.id); setMessage(''); setReplying(null); setExpanded({}); setThread(null); await client.invalidateQueries({ queryKey: ['comments', aid] }) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setSending(false) }
  }
  const beginReply = (target: BiliComment) => { setReplying(target); setMessage('') }
  const items = [...new Map(comments.data?.pages.flatMap((page) => page.items).map((comment) => [comment.id, comment]) || []).values()]
  const threadReplies = thread ? expanded[thread.id] || [] : []

  return <CommentsSurface onClose={onClose} forceExpanded={Boolean(thread)}>
    {thread ? <>
      <header className="comments-thread-header"><button onClick={() => setThread(null)} aria-label="返回评论列表"><ArrowLeft /></button><div><strong>评论回复</strong><small>{thread.replyCount} 条回复</small></div></header>
      <div className="comments-scroll comments-thread-scroll">
        <CommentRow comment={shown(thread)} hideExpand onExpand={() => undefined} onReply={beginReply} onLike={(target) => void like(target)} pending={likePending.has(thread.id)} />
        <div className="comments-thread-divider">全部回复</div>
        {threadReplies.map(reply => <CommentRow key={reply.id} comment={shown(reply)} nested hideExpand onExpand={() => undefined} onReply={beginReply} onLike={(target) => void like(target)} pending={likePending.has(reply.id)} />)}
        {loadingReplies === thread.id && <div className="comments-status compact"><LoaderCircle className="spin" />正在加载回复</div>}
        {replyPages[thread.id] > 0 && threadReplies.length < thread.replyCount && <button className="load-more" onClick={() => void loadReplies(thread, replyPages[thread.id] + 1)}>加载更多回复</button>}
      </div>
    </> : <>
      <header><div><span className="eyebrow">COMMENTS</span><h3>评论 {comments.data ? `(${comments.data.pages[0].total})` : ''}</h3></div><button onClick={onClose} aria-label="关闭评论">{isIOS ? <ChevronDown /> : <X />}</button></header>
      <div className="comments-scroll">{comments.isLoading ? <div className="comments-status"><LoaderCircle className="spin" />加载评论</div> : <>{items.map((source) => {
        const comment = shown(source)
        return <div key={comment.id}><CommentRow comment={comment} replies={isIOS ? undefined : expanded[comment.id]?.map(shown)} onExpand={() => void expand(comment)} onReply={beginReply} onLike={(target) => void like(target)} pending={likePending.has(comment.id)} />{loadingReplies === comment.id ? <small>正在加载回复…</small> : !isIOS && expanded[comment.id] && replyPages[comment.id] > 0 && expanded[comment.id].length < comment.replyCount && <button className="load-more" onClick={() => void loadReplies(comment, replyPages[comment.id] + 1)}>加载更多回复</button>}</div>
      })}{!items.length && !comments.isError && <div className="comments-status">还没有评论</div>}{comments.hasNextPage && <button className="load-more" disabled={comments.isFetchingNextPage} onClick={() => void comments.fetchNextPage()}>{comments.isFetchingNextPage ? '加载中…' : '加载更多评论'}</button>}{comments.isError && <button className="load-more" onClick={() => void comments.refetch()}>{commandErrorMessage(comments.error)} · 重试</button>}</>}</div>
    </>}
    <form className="comment-compose" onSubmit={submit}>{replying && <div><span>回复 <b>@{replying.userName}</b></span><button type="button" onClick={() => { setReplying(null); setMessage('') }}>取消</button></div>}<textarea maxLength={1000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={replying ? `回复 @${replying.userName}` : '友善地说点什么…'} />{error && <small>{error}</small>}<button disabled={sending || !message.trim()}>{sending ? <LoaderCircle className="spin" /> : <Send />}发送</button></form>
  </CommentsSurface>
})

function splitReply(message: string) {
  const match = message.match(/^(?:回复\s*)?@([^\s:：]+)\s*[:：]\s*([\s\S]*)$/)
  return match ? { target: match[1], body: match[2] } : { body: message }
}

function CommentRow({ comment, replies, onExpand, onReply, onLike, nested = false, hideExpand = false, pending = false }: { comment: BiliComment; replies?: BiliComment[]; onExpand: () => void; onReply: (comment: BiliComment) => void; onLike: (comment: BiliComment) => void; nested?: boolean; hideExpand?: boolean; pending?: boolean }) {
  const content = splitReply(comment.message)
  return <article className={nested ? 'comment-row nested' : 'comment-row'}><img src={comment.avatarUrl} alt="" loading="lazy" /><div><header><strong>{comment.userName}</strong><small>{new Date(comment.createdAt * 1000).toLocaleDateString()}</small></header><p>{content.target && <><span className="reply-prefix">回复</span> <button className="reply-target" onClick={() => onReply(comment)}>@{content.target}</button><span className="reply-colon">：</span></>}{content.body}</p><footer><button aria-busy={pending} onClick={() => onLike(comment)} className={comment.liked ? 'liked' : ''}><Heart fill={comment.liked ? 'currentColor' : 'none'} />{comment.likeCount || ''}</button><button onClick={() => onReply(comment)}><MessageCircle />回复</button>{!hideExpand && !nested && comment.replyCount > 0 && <button onClick={onExpand}>{replies ? '收起回复' : `查看 ${comment.replyCount} 条回复`}<ChevronDown /></button>}</footer>{replies && <div className="nested-comments">{replies.map((reply) => <CommentRow key={reply.id} comment={reply} nested hideExpand onExpand={() => undefined} onReply={onReply} onLike={onLike} />)}<button className="collapse-replies" onClick={onExpand}>收起回复</button></div>}</div></article>
}
