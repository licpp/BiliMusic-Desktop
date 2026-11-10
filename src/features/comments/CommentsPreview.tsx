import { memo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { MessageCircle } from 'lucide-react'
import { commentQuery } from './commentQuery'
import { CommentBody } from './CommentBody'

export const CommentsPreview = memo(function CommentsPreview({ aid, onOpen }: { aid: number; onOpen: () => void }) {
  const comments = useInfiniteQuery(commentQuery(aid))
  const page = comments.data?.pages[0]
  if (!page || page.total < 1 || page.total > 2 || !page.items.length) return null
  return <aside className="lyrics-comments-preview">
    <button onClick={onOpen}><MessageCircle size={15}/>评论 · {page.total}</button>
    {page.items.slice(0, 2).map(item => <div key={item.id}><strong>{item.userName}</strong><p><CommentBody body={item.message} emotes={item.emotes}/></p></div>)}
  </aside>
})
