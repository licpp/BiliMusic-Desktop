import { infiniteQueryOptions } from '@tanstack/react-query'
import { accountEpoch } from '../../services/accountScope'
import { getComments } from '../../services/desktopApi'

export function commentQuery(aid: number) {
  return infiniteQueryOptions({
    queryKey: ['comments', aid, accountEpoch()],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => getComments(aid, pageParam),
    getNextPageParam: last => last.isEnd ? undefined : last.next,
    staleTime: 60_000,
  })
}
