import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Heart, LoaderCircle, MessageCircle, Send, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { commandErrorMessage, getCommentReplies, getComments, replyComment, setCommentLike, type BiliComment } from '../../services/desktopApi'

export function CommentsPanel({ aid, onClose }: { aid: number; onClose: () => void }) {
  const client = useQueryClient()
  const comments = useQuery({ queryKey: ['comments', aid], queryFn: () => getComments(aid, 1) })
  const [expanded, setExpanded] = useState<Record<number, BiliComment[]>>({})
  const [replying, setReplying] = useState<BiliComment | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  const expand = async (comment: BiliComment) => {
    if (expanded[comment.id]) { setExpanded((value) => { const next = { ...value }; delete next[comment.id]; return next }); return }
    try { setExpanded((value) => ({ ...value, [comment.id]: comment.replies.length ? comment.replies : [] })); const replies = await getCommentReplies(aid, comment.rootId, 1); setExpanded((value) => ({ ...value, [comment.id]: replies })) }
    catch (cause) { setError(commandErrorMessage(cause)) }
  }
  const like = async (comment: BiliComment) => {
    try { await setCommentLike(aid, comment.id, !comment.liked); await client.invalidateQueries({ queryKey: ['comments', aid] }) }
    catch (cause) { setError(commandErrorMessage(cause)) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!message.trim()) return
    setSending(true); setError('')
    try { await replyComment(aid, message, replying?.rootId, replying?.id); setMessage(''); setReplying(null); await client.invalidateQueries({ queryKey: ['comments', aid] }) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setSending(false) }
  }
  return <aside className="comments-panel"><header><div><span className="eyebrow">COMMENTS</span><h3>评论 {comments.data ? `(${comments.data.total})` : ''}</h3></div><button onClick={onClose}><X /></button></header><div className="comments-scroll">{comments.isLoading ? <div className="comments-status"><LoaderCircle className="spin" />加载评论</div> : comments.isError ? <div className="comments-status">{commandErrorMessage(comments.error)}</div> : comments.data?.items.map((comment) => <CommentRow key={comment.id} comment={comment} replies={expanded[comment.id]} onExpand={() => void expand(comment)} onReply={(target) => { setReplying(target); setMessage('') }} onLike={(target) => void like(target)} />)}</div><form className="comment-compose" onSubmit={submit}>{replying && <div><span>回复 @{replying.userName}</span><button type="button" onClick={() => { setReplying(null); setMessage('') }}>取消</button></div>}<textarea maxLength={1000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={replying ? `回复 @${replying.userName}` : '友善地说点什么…'} />{error && <small>{error}</small>}<button disabled={sending || !message.trim()}>{sending ? <LoaderCircle className="spin" /> : <Send />}发送</button></form></aside>
}

function CommentRow({ comment, replies, onExpand, onReply, onLike, nested = false }: { comment: BiliComment; replies?: BiliComment[]; onExpand: () => void; onReply: (comment: BiliComment) => void; onLike: (comment: BiliComment) => void; nested?: boolean }) {
  return <article className={nested ? 'comment-row nested' : 'comment-row'}><img src={comment.avatarUrl} alt="" loading="lazy" /><div><header><strong>{comment.userName}</strong><small>{new Date(comment.createdAt * 1000).toLocaleDateString()}</small></header><p>{comment.message}</p><footer><button onClick={() => onLike(comment)} className={comment.liked ? 'liked' : ''}><Heart fill={comment.liked ? 'currentColor' : 'none'} />{comment.likeCount || ''}</button><button onClick={() => onReply(comment)}><MessageCircle />回复</button>{!nested && comment.replyCount > 0 && <button onClick={onExpand}>{replies ? '收起回复' : `查看 ${comment.replyCount} 条回复`}<ChevronDown /></button>}</footer>{replies && <div className="nested-comments">{replies.map((reply) => <CommentRow key={reply.id} comment={reply} nested onExpand={() => undefined} onReply={onReply} onLike={onLike} />)}</div>}</div></article>
}
