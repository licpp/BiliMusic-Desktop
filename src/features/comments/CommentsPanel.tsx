import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Heart, LoaderCircle, MessageCircle, Send, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { commandErrorMessage, getCommentReplies, getComments, replyComment, setCommentLike, type BiliComment } from '../../services/desktopApi'

export function CommentsPanel({ aid, onClose }: { aid: number; onClose: () => void }) {
  const client = useQueryClient()
  const comments = useInfiniteQuery({ queryKey: ['comments', aid], initialPageParam: 1, queryFn: ({ pageParam }) => getComments(aid, pageParam), getNextPageParam: (last) => last.isEnd ? undefined : last.next })
  const [expanded, setExpanded] = useState<Record<number, BiliComment[]>>({})
  const [replyPages, setReplyPages] = useState<Record<number, number>>({})
  const [loadingReplies, setLoadingReplies] = useState<number | null>(null)
  const [likePending, setLikePending] = useState<number | null>(null)
  const [replying, setReplying] = useState<BiliComment | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  const expand = async (comment: BiliComment) => {
    if (expanded[comment.id]) { setExpanded((value) => { const next = { ...value }; delete next[comment.id]; return next }); return }
    await loadReplies(comment, 1)
  }
  const loadReplies = async (comment: BiliComment, page: number) => {
    setLoadingReplies(comment.id)
    try { const replies = await getCommentReplies(aid, comment.rootId, page); setExpanded((value) => ({ ...value, [comment.id]: [...new Map([...(page === 1 ? [] : value[comment.id] || []), ...replies].map((reply) => [reply.id, reply])).values()] })); setReplyPages((value) => ({ ...value, [comment.id]: replies.length < 20 ? -1 : page })) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setLoadingReplies(null) }
  }
  const like = async (comment: BiliComment) => {
    if (likePending) return
    setLikePending(comment.id)
    try { await setCommentLike(aid, comment.id, !comment.liked); setExpanded((value) => Object.fromEntries(Object.entries(value).map(([id, replies]) => [id, replies.map((reply) => reply.id === comment.id ? { ...reply, liked: !reply.liked, likeCount: Math.max(0, reply.likeCount + (reply.liked ? -1 : 1)) } : reply)]))); await client.invalidateQueries({ queryKey: ['comments', aid] }) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setLikePending(null) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!message.trim()) return
    setSending(true); setError('')
    try { await replyComment(aid, message, replying?.rootId, replying?.id); setMessage(''); setReplying(null); setExpanded({}); await client.invalidateQueries({ queryKey: ['comments', aid] }) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setSending(false) }
  }
  const items = [...new Map(comments.data?.pages.flatMap((page) => page.items).map((comment) => [comment.id, comment]) || []).values()]
  return <aside className="comments-panel"><header><div><span className="eyebrow">COMMENTS</span><h3>评论 {comments.data ? `(${comments.data.pages[0].total})` : ''}</h3></div><button onClick={onClose}><X /></button></header><div className="comments-scroll">{comments.isLoading ? <div className="comments-status"><LoaderCircle className="spin" />加载评论</div> : <>{items.map((comment) => <div key={comment.id}><CommentRow comment={comment} replies={expanded[comment.id]} onExpand={() => void expand(comment)} onReply={(target) => { setReplying(target); setMessage('') }} onLike={(target) => void like(target)} />{loadingReplies === comment.id ? <small>正在加载回复…</small> : expanded[comment.id] && replyPages[comment.id] > 0 && expanded[comment.id].length < comment.replyCount && <button className="load-more" onClick={() => void loadReplies(comment, replyPages[comment.id] + 1)}>加载更多回复</button>}</div>)}{!items.length && !comments.isError && <div className="comments-status">还没有评论</div>}{comments.hasNextPage && <button className="load-more" disabled={comments.isFetchingNextPage} onClick={() => void comments.fetchNextPage()}>{comments.isFetchingNextPage ? '加载中…' : '加载更多评论'}</button>}{comments.isError && <button className="load-more" onClick={() => void comments.refetch()}>{commandErrorMessage(comments.error)} · 重试</button>}</>}</div><form className="comment-compose" onSubmit={submit}>{replying && <div><span>回复 @{replying.userName}</span><button type="button" onClick={() => { setReplying(null); setMessage('') }}>取消</button></div>}<textarea maxLength={1000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={replying ? `回复 @${replying.userName}` : '友善地说点什么…'} />{error && <small>{error}</small>}<button disabled={sending || !message.trim()}>{sending ? <LoaderCircle className="spin" /> : <Send />}发送</button></form></aside>
}

function CommentRow({ comment, replies, onExpand, onReply, onLike, nested = false }: { comment: BiliComment; replies?: BiliComment[]; onExpand: () => void; onReply: (comment: BiliComment) => void; onLike: (comment: BiliComment) => void; nested?: boolean }) {
  return <article className={nested ? 'comment-row nested' : 'comment-row'}><img src={comment.avatarUrl} alt="" loading="lazy" /><div><header><strong>{comment.userName}</strong><small>{new Date(comment.createdAt * 1000).toLocaleDateString()}</small></header><p>{comment.message}</p><footer><button onClick={() => onLike(comment)} className={comment.liked ? 'liked' : ''}><Heart fill={comment.liked ? 'currentColor' : 'none'} />{comment.likeCount || ''}</button><button onClick={() => onReply(comment)}><MessageCircle />回复</button>{!nested && comment.replyCount > 0 && <button onClick={onExpand}>{replies ? '收起回复' : `查看 ${comment.replyCount} 条回复`}<ChevronDown /></button>}</footer>{replies && <div className="nested-comments">{replies.map((reply) => <CommentRow key={reply.id} comment={reply} nested onExpand={() => undefined} onReply={onReply} onLike={onLike} />)}</div>}</div></article>
}
