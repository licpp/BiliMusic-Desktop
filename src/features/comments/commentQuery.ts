import { accountQueryKey } from '../../services/queryKeys'
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { accountEpoch } from '../../services/accountScope'
import { getComments } from '../../services/desktopApi'
import type { CommentPage } from '../../domain/comments'

export function commentQuery(aid: number) {
  return infiniteQueryOptions({
    queryKey: accountQueryKey('comments', aid),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => getComments(aid, pageParam),
    getNextPageParam: last => last.isEnd ? undefined : last.next,
    staleTime: 60_000,
  })
}

export function commentReplyPageQuery(aid: number, root: string, page: number) {
  const epoch = accountEpoch()
  return queryOptions({
    queryKey: accountQueryKey('comment-replies-page', aid, root, page),
    queryFn: async ({ signal }) => {
      if (signal.aborted || epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
      const replies = await invoke<CommentPage>('bili_comment_reply_page', { aid, root, page })
      if (signal.aborted || epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
      return replies
    },
    staleTime: 60_000,
    retry: false,
  })
}
