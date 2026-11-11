import { listen } from '@tauri-apps/api/event'
import { formatAudienceCount } from '../../shared/count'
import { accountEpoch } from '../../services/accountScope'
import { formatDuration } from '../../shared/time'
import { invoke } from '@tauri-apps/api/core'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Bookmark, Check, RefreshCw } from 'lucide-react'
import {
  readCollectionProgress,
  changeCollection,
  listCollections,
  type Collection,
} from '../../services/collections'
import { commandErrorMessage, getVideoParts } from '../../services/desktopApi'
import { creatorVideoRow, seasonTracks } from '../../services/mediaSources'
import {
  playbackIntent,
  seasonPlaybackQueue,
  usePlayerStore,
} from '../player/playerStore'
import { toTrack } from '../../services/collectionTrack'
import { VideoPartsList } from '../library/VideoPartsList'
import { Artwork } from '../../shared/Artwork'
import { LoadMore } from '../../shared/LoadMore'
import { SegmentedTabs } from '../../shared/SegmentedTabs'

type Creator = {
  mid: number
  uname: string
  upic: string
  usign?: string
  fans?: number
}
type Catalog = { data: any; page: number }
const catalog = (action: string, mid?: number, page = 1, keyword = '') =>
  invoke<Catalog>('bili_creator_catalog', { action, mid, page, keyword })
export const creatorItem = (up: Creator): Collection => ({
  followers: up.fans,
  bvid: `up:${up.mid}`,
  folderId: '',
  title: up.uname,
  coverUrl: up.upic?.replace(/^http:/, 'https:'),
  uploaderName: up.uname,
})

export function CreatorFollow({ item }: { item: Collection }) {
  const client = useQueryClient()
  const saved = useQuery({
    queryKey: ['collections'],
    queryFn: listCollections,
  })
  const followed = saved.data?.items.some((value) => value.bvid === item.bvid)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <>
      <button
        className="collection-flat-button"
        disabled={busy}
        aria-label={followed ? '取消关注 UP 主' : '关注 UP 主'}
        onClick={async () => {
          setBusy(true)
          setError('')
          try {
            await changeCollection(
              followed ? 'remove' : 'save',
              item.bvid,
              '',
              item,
            )
            await client.invalidateQueries({ queryKey: ['collections'] })
          } catch (cause) {
            setError(commandErrorMessage(cause))
          } finally {
            setBusy(false)
          }
        }}
      >
        {followed ? <Check size={18} /> : <Bookmark size={18} />}
        <span>{followed ? '已关注' : '关注'}</span>
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  )
}

function CreatorEntry({
  item,
  onOpen,
  sidebar = false,
}: {
  item: Collection
  sidebar?: boolean
  onOpen: (item: Collection) => void
}) {
  const profile = useQuery({
    queryKey: ['creator-profile', item.bvid],
    queryFn: () => catalog('profile', Number(item.bvid.slice(3))),
    enabled: !item.title || item.followers === undefined,
    staleTime: 300000,
  })
  const card = profile.data?.data.card
  const display = card
    ? {
        ...item,
        followers: profile.data?.data.follower ?? card.fans,
        title: card.name,
        coverUrl: card.face,
        uploaderName: card.name,
      }
    : { ...item, title: item.title || `UP 主 ${item.bvid.slice(3)}` }
  return (
    <div className={`creator-row${sidebar ? ' creator-sidebar-row' : ''}`}>
      <button className="creator-open" onClick={() => onOpen(display)}>
        <Artwork src={display.coverUrl} />
        <span className="creator-copy">
          <strong>{display.title}</strong>
          {display.followers !== undefined && (
            <small>{formatAudienceCount(display.followers)} 粉丝</small>
          )}
        </span>
      </button>
      {!sidebar && <CreatorFollow item={display} />}
    </div>
  )
}

export function CreatorsView({
  query,
  onOpen,
  followed = false,
  sidebar = false,
}: {
  query?: string
  onOpen: (item: Collection) => void
  followed?: boolean
  sidebar?: boolean
}) {
  const saved = useQuery({
    queryKey: ['collections'],
    queryFn: listCollections,
  })
  const result = useInfiniteQuery({
    queryKey: ['creator-search', query],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => catalog('search', undefined, pageParam, query),
    enabled: !followed && Boolean(query),
    getNextPageParam: (last) =>
      last.page * 20 < last.data.numResults ? last.page + 1 : undefined,
  })
  const items: Collection[] = followed
    ? saved.data?.items.filter((item) => item.bvid.startsWith('up:')) || []
    : result.data?.pages.flatMap((page) =>
        (page.data.result || []).map((up: Creator) => creatorItem(up)),
      ) || []
  return (
    <section className={`creators-view${sidebar ? ' creators-sidebar' : ''}`}>
      {followed && <h2>关注</h2>}
      {(result.error || saved.error) && (
        <p role="alert">{commandErrorMessage(result.error || saved.error)}</p>
      )}
      {items.map((item) => (
        <CreatorEntry
          key={item.bvid}
          item={item}
          onOpen={onOpen}
          sidebar={sidebar}
        />
      ))}
      {result.isLoading && <p>正在搜索 UP 主…</p>}
      {!items.length && !result.isLoading && (
        <p className="batch-message">
          {followed
            ? '关注喜欢的 UP 主，随时查看最新投稿'
            : '没有找到相关 UP 主'}
        </p>
      )}
      {result.hasNextPage && (
        <LoadMore
          label="加载更多"
          busy={result.isFetchingNextPage}
          onLoad={() => void result.fetchNextPage()}
        />
      )}
    </section>
  )
}

export function CreatorPage({
  item,
  onOpen,
}: {
  item: Collection
  onOpen?: (item: Collection) => void
}) {
  const mid = Number(item.bvid.slice(3))
  const profile = useQuery({
    queryKey: ['creator-profile', item.bvid],
    queryFn: () => catalog('profile', mid),
    staleTime: 300000,
  })
  const followers =
    profile.data?.data.follower ??
    profile.data?.data.card?.fans ??
    item.followers
  const saved = useQuery({
    queryKey: ['collections'],
    queryFn: listCollections,
  })
  const followed = saved.data?.items.some((value) => value.bvid === item.bvid)
  const checkpoint = useQuery({
    queryKey: ['collection-progress', accountEpoch(), item.bvid],
    queryFn: () => readCollectionProgress(item.bvid),
    enabled: Boolean(followed),
  })
  useEffect(() => {
    if (!followed) return
    const subscription = listen<string>('collection-progress-changed', event => {
      if (event.payload === item.bvid) void checkpoint.refetch()
    }).catch(() => undefined)
    return () => { void subscription.then(stop => stop?.()) }
  }, [followed, item.bvid, checkpoint.refetch])
  const [resuming, setResuming] = useState(false)

  const [tab, setTab] = useState<'videos' | 'seasons'>('videos')
  const [parts, setParts] =
    useState<Awaited<ReturnType<typeof getVideoParts>>>()
  const [error, setError] = useState('')
  const result = useInfiniteQuery({
    queryKey: ['creator-catalog', mid, tab],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => catalog(tab, mid, pageParam),
    getNextPageParam: (last) => {
      const count =
        tab === 'videos'
          ? last.data.page?.count
          : last.data.items_lists?.page?.total
      return last.page * (tab === 'videos' ? 30 : 20) < count
        ? last.page + 1
        : undefined
    },
  })
  const videos =
    result.data?.pages.flatMap((page) => page.data.list?.vlist || []) || []
  const seasons =
    result.data?.pages.flatMap(
      (page) => page.data.items_lists?.seasons_list || [],
    ) || []
  const queue = seasonTracks({
    unavailable: 0,
    summary: {
      id: mid,
      uploaderId: mid,
      title: item.title,
      uploaderName: item.title,
      coverUrl: item.coverUrl,
    },
    tracks: videos.map(creatorVideoRow),
  })
  return (
    <section className="creator-page">
      <header className="creator-row">
        <div className="creator-open">
          <Artwork src={profile.data?.data.card?.face || item.coverUrl} />
          <div>
            <h2>
              {profile.data?.data.card?.name || item.title || `UP 主 ${mid}`}
            </h2>
            {followers !== undefined && (
              <small>{formatAudienceCount(followers)} 粉丝</small>
            )}
          </div>
        </div>
        <CreatorFollow item={item} />
        <button
          className="collection-icon"
          aria-label="刷新投稿"
          onClick={() => void result.refetch()}
        >
          <RefreshCw size={18} />
        </button>
      </header>
      {followed && checkpoint.data && (
        <button
          className="collection-flat-button"
          disabled={resuming}
          onClick={async () => {
            setResuming(true)
            setError('')
            const scope = accountEpoch(),
              intent = playbackIntent()
            const point = checkpoint.data!
            try {
              let entries = [...videos],
                page = result.data?.pages.length || 0
              let total = result.data?.pages[0]?.data.page?.count ?? Infinity
              while (
                !entries.some((video) => video.bvid === point.bvid) &&
                entries.length < total
              ) {
                const next = await catalog('videos', mid, ++page)
                if (scope !== accountEpoch() || intent !== playbackIntent())
                  return
                const rows = next.data.list?.vlist || []
                if (!rows.length) break
                entries.push(...rows)
                total = next.data.page?.count ?? entries.length
              }
              if (!entries.some((video) => video.bvid === point.bvid))
                throw new Error('上次播放的视频已不在这个 UP 主的投稿中')
              const detail = await getVideoParts(point.bvid)
              if (scope !== accountEpoch() || intent !== playbackIntent())
                return
              const parts = detail.parts.map((part) => toTrack(detail, part))
              const selected = parts.find(
                (track) => track.source.cid === point.cid,
              )
              if (!selected) throw new Error('上次播放的分 P 已不可用')
              const full = seasonTracks({
                unavailable: 0,
                summary: {
                  id: mid,
                  uploaderId: mid,
                  title: item.title,
                  uploaderName: item.title,
                  coverUrl: item.coverUrl,
                },
                tracks: entries.map(creatorVideoRow),
              })
              await usePlayerStore
                .getState()
                .playFromList(
                  seasonPlaybackQueue(full, selected, parts),
                  selected.id,
                  {
                    kind: 'season',
                    title: item.title,
                    collectionRef: item.bvid,
                    creatorMid: mid,
                    creatorPage: page,
                    creatorTotal: total,
                  },
                  point.positionMs / 1000,
                )
            } catch (cause) {
              setError(commandErrorMessage(cause))
            } finally {
              setResuming(false)
            }
          }}
        >
          {resuming
            ? '正在读取…'
            : `继续播放 · ${formatDuration(checkpoint.data.positionMs / 1000)}`}
        </button>
      )}
      <SegmentedTabs
        className="listening-tabs"
        tabs={[
          { id: 'videos', label: '全部投稿' },
          { id: 'seasons', label: '合集' },
        ]}
        value={tab}
        onChange={(value) => {
          setParts(undefined)
          setTab(value)
        }}
        idPrefix="creator"
        panelId="creator-content"
        label="UP 主内容"
      />
      <div id="creator-content">
        {result.isLoading && <p>正在读取投稿…</p>}
        {(result.error || error) && (
          <p role="alert">{commandErrorMessage(result.error || error)}</p>
        )}
        {tab === 'videos' ? (
          <VideoPartsList
            videoCollection
            locateCurrent
            tracks={queue}
            queueSource={{
              kind: 'season',
              title: item.title,
              collectionRef: item.bvid,
              creatorMid: mid,
              creatorPage: result.data?.pages.length || 1,
              creatorTotal: result.data?.pages[0]?.data.page?.count || 0,
            }}
            onOpenParts={(track) => {
              void getVideoParts(track.source.bvid)
                .then(setParts)
                .catch((cause) => setError(commandErrorMessage(cause)))
            }}
          />
        ) : (
          seasons.map((season) => (
            <button
              className="creator-row creator-season"
              key={season.meta.season_id}
              onClick={() =>
                onOpen?.({
                  bvid: `season:${mid}:${season.meta.season_id}`,
                  folderId: '',
                  title: season.meta.name,
                  coverUrl: season.meta.cover,
                  uploaderName: item.title,
                })
              }
            >
              <Artwork src={season.meta.cover} />
              <strong>{season.meta.name}</strong>
              <small>{season.meta.total} 个视频</small>
            </button>
          ))
        )}
        {parts && parts.parts.length > 0 && (
          <div>
            <button
              className="collection-flat-button"
              onClick={() => setParts(undefined)}
            >
              收起选集
            </button>
            <VideoPartsList
              tracks={parts.parts.map((part) => toTrack(parts, part))}
              playbackTracks={seasonPlaybackQueue(
                queue,
                toTrack(parts, parts.parts[0]),
                parts.parts.map((part) => toTrack(parts, part)),
              )}
              queueSource={{
                kind: 'season',
                title: item.title,
                collectionRef: item.bvid,
                creatorMid: mid,
                creatorPage: result.data?.pages.length || 1,
                creatorTotal: result.data?.pages[0]?.data.page?.count || 0,
              }}
            />
          </div>
        )}
        {result.hasNextPage && (
          <LoadMore
            label="加载更多"
            busy={result.isFetchingNextPage}
            onLoad={() => void result.fetchNextPage()}
          />
        )}
      </div>
    </section>
  )
}
