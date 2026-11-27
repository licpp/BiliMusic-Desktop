import { useInfiniteQuery } from '@tanstack/react-query'
import { getBilibiliFeed } from '../services/biliFeed'
import { biliRequestPause } from '../services/biliRequestStatus'
import { accountQueryKey } from '../services/queryKeys'
import { LoadMore } from '../shared/LoadMore'
import { useListRows } from '../shared/useListRows'
import { Empty, Failure, LargeVideoCard, type Navigate } from './Library'
import { useVideoEntry } from './useVideoEntry'

export function LargeBilibiliFeed({ navigate }: { navigate: Navigate }) {
  const result = useInfiniteQuery({
    queryKey: accountQueryKey('large-bili-feed'),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => getBilibiliFeed(pageParam),
    getNextPageParam: last => last.nextPage ?? undefined,
    staleTime: Infinity,
    retry: false,
  })
  const opener = useVideoEntry(navigate, 'large-bili-feed')
  const videos = [...new Map(result.data?.pages.flatMap(page => page.items.map(item => [item.bvid, item] as const))).values()]
  const rendered = useListRows(videos, 'large-bili-feed', { active: true })
  if (biliRequestPause(result.error)?.reason === 'authRequired') {
    return <div className="large-empty"><p>登录 B 站后查看推荐</p><button type="button" onClick={() => navigate({ kind: 'settings' })}>前往账号设置</button></div>
  }
  return <>
    <Failure error={opener.error}/>
    <Failure error={result.isFetchNextPageError ? undefined : result.error} retry={() => void result.refetch()}/>
    {result.isPending && <p className="large-muted" role="status">正在读取推荐…</p>}
    {result.isSuccess && !videos.length && <Empty>暂无推荐视频</Empty>}
    <div className="large-grid large-search-results" aria-label="B 站推荐视频">
      {rendered.rows.map(video => <LargeVideoCard key={video.bvid} video={video} opener={opener} focusPrefix="bili-feed"/>)}
      {rendered.more && <div ref={rendered.tail} className="list-render-tail" aria-hidden="true"/>}
    </div>
    {result.hasNextPage && !rendered.more && <LoadMore busy={result.isFetchingNextPage} automatic={!result.isFetchNextPageError}
      onLoad={() => void result.fetchNextPage({ cancelRefetch: false })} label={result.isFetchNextPageError ? '重试加载' : '加载更多推荐'}/>}
  </>
}
