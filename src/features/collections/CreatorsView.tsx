import { useListRows } from '../../shared/useListRows'
import { useListDataDuringNavigation, useListReveal } from '../../shared/useListMotion'
import { ListSkeleton } from '../../shared/ListSkeleton'
import { accountQueryKey } from '../../services/queryKeys'
import { CoverCount } from '../../shared/CoverCount'
import { ScopedSearchField } from '../search/ScopedSearchField'
import { FolderMenu } from './CollectionFolderControls'
import { LibraryEntry } from '../library/LibraryEntry'
import { CreatorActions, CreatorManager } from './CreatorTools'
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
import { useEffect, useMemo, useRef, useState } from 'react'
import { UserRound, ArrowLeft, Folder, ChevronDown, ChevronRight, Bookmark, Check, RefreshCw, Play, LoaderCircle } from 'lucide-react'
import {
  readCollectionProgress,
  changeCollection,
  listCollections,
  type Collection,
} from '../../services/collections'
import { commandErrorMessage, getVideoParts } from '../../services/desktopApi'
import { creatorVideoRow } from '../../services/mediaSources'
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
const creatorVideos = (pages?: Catalog[]) => [...new Map((pages?.flatMap(page => page.data.list?.vlist || []) || [])
  .map(video => [video.bvid, video])).values()]
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
    queryKey: accountQueryKey('collections'),
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
            await client.invalidateQueries({ queryKey: accountQueryKey('collections') })
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
  folders = [],
  editable = false,
}: {
  editable?: boolean
  folders?: import('../../services/collections').CollectionFolder[]
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
  const subtitle=[item.note?display.title:'',display.followers!==undefined?`${formatAudienceCount(display.followers)} 粉丝`:''].filter(Boolean).join(' · ')
  return <LibraryEntry className="creator-entry" title={item.note||display.title} subtitle={subtitle} sidebar={sidebar} coverClassName="creator-avatar-cover" cover={<Artwork src={display.coverUrl} fallback={<UserRound size={22}/>}/>} onOpen={()=>onOpen(display)} menu={position=><>{!sidebar&&!editable&&<CreatorFollow item={display}/>} {editable&&<CreatorActions item={item} folders={folders} contextPosition={position}/>}</>}/>
}

export function CreatorsView({
  query,
  onOpen,
  followed = false,
  sidebar = false,
  folderId, onOpenFolder, onFolderRemoved,
}: {
  folderId?:string;onOpenFolder?:(id:string)=>void;onFolderRemoved?:(id:string)=>void
  query?: string
  onOpen: (item: Collection) => void
  followed?: boolean
  sidebar?: boolean
}) {
  const [group, setGroup] = useState('all')
  const [expanded, setExpanded] = useState(() => localStorage.getItem('creators-expanded') !== 'false')
  const saved = useQuery({
    queryKey: accountQueryKey('collections'),
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
  const followedData = useListDataDuringNavigation(saved.data, 'followed-creators', !sidebar)
  const found = useListDataDuringNavigation(result.data, query)
  const folders = (followedData?.folders || []).filter(folder => folder.scope === 'creators')
  const savedCreators = new Map(followedData?.items.filter(item => item.bvid.startsWith('up:')).map(item => [item.bvid, item]))
  const items: Collection[] = followed ? [...savedCreators.values()] :
    found?.pages.flatMap(page => (page.data.result || []).map((up: Creator) => creatorItem(up))) || []
  const selectedFolder=folderId??(group==='all'?undefined:group)
  const root=selectedFolder===undefined
  const visibleItems = followed ? items.filter(item => item.folderId === (selectedFolder || '')) : items
  const loading = followed ? saved.isLoading || Boolean(saved.data && !followedData) : result.isLoading || Boolean(result.data && !found)
  const rowsRef = useRef<HTMLDivElement>(null)
  const rendered = useListRows(visibleItems, followed ? `followed:${selectedFolder ?? ''}` : `creator-search:${query ?? ''}`, { active: !sidebar || expanded })
  useListReveal(rowsRef, loading, Boolean(visibleItems.length), !sidebar || expanded)
  const openFolder=(id:string)=>onOpenFolder?onOpenFolder(id):setGroup(id)
  return (
    <section className={`creators-view${sidebar ? ' creators-sidebar' : ''}`}>
      {followed && root && <CreatorManager sidebar={sidebar} expanded={expanded} onToggle={()=>setExpanded(value=>{localStorage.setItem('creators-expanded',String(!value));return !value})} folders={folders} items={items}/>}
      {followed&&!root&&<div className="collections-heading"><h3>{folders.find(f=>f.id===selectedFolder)?.name||'关注文件夹'}</h3><div className="collections-heading-actions">{!folderId&&<button className="collection-icon" aria-label="返回关注" onClick={()=>setGroup('all')}><ArrowLeft size={18}/></button>}{folders.filter(f=>f.id===selectedFolder).map(folder=><FolderMenu key={folder.id} creator folder={folder} onChanged={()=>void saved.refetch()} onRemoved={()=>{setGroup('all');onFolderRemoved?.(folder.id)}}/>)}</div></div>}
      <div hidden={sidebar && !expanded}>
      {followed&&root&&folders.map(folder=><LibraryEntry coverBadge="folder" key={folder.id} title={folder.name} subtitle={`${items.filter(item=>item.folderId===folder.id).length} 位 UP 主`} sidebar={sidebar} cover={<Artwork fallback={<Folder aria-hidden="true"/>}/>} onOpen={()=>openFolder(folder.id)} menu={position=><FolderMenu creator folder={folder} contextPosition={position} onOpen={()=>openFolder(folder.id)} onChanged={()=>void saved.refetch()} onRemoved={()=>{if(selectedFolder===folder.id)setGroup('all');onFolderRemoved?.(folder.id)}}/>}/>)}
      {(result.error || saved.error) && (
        <p role="alert">{commandErrorMessage(result.error || saved.error)}</p>
      )}
      {loading && !sidebar && <ListSkeleton label={followed ? '正在读取关注' : '正在搜索 UP 主'}/>}
      <div ref={rowsRef}>
      {rendered.rows.map((item) => (
        <CreatorEntry
          key={item.bvid}
          item={{...item,...savedCreators.get(item.bvid)}}
          editable={savedCreators.has(item.bvid)}
          onOpen={onOpen}
          sidebar={sidebar}
          folders={folders}
        />
      ))}
      {rendered.more && <div ref={rendered.tail} className="list-render-tail" aria-hidden="true"/>}
      </div>
      {!visibleItems.length && (!root || !folders.length) && !loading && (
        <p className="batch-message">
          {sidebar ? '暂无关注' : followed
            ? root ? '关注喜欢的 UP 主，随时查看最新投稿' : '这个关注文件夹还没有 UP 主。'
            : '没有找到相关 UP 主'}
        </p>
      )}
      {result.hasNextPage && !rendered.more && (
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

export function CreatorPage({
  item,
  onOpen,
  searchQuery,
}: {
  item: Collection
  onOpen?: (item: Collection) => void
  searchQuery?: string
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
    queryKey: accountQueryKey('collections'),
    queryFn: listCollections,
  })
  const followed = saved.data?.items.some((value) => value.bvid === item.bvid)
  const checkpoint = useQuery({
    queryKey: accountQueryKey('collection-progress', item.bvid),
    queryFn: () => readCollectionProgress(item.bvid),
    enabled: Boolean(followed),
  })
  useEffect(() => {
    if (!followed) return
    const subscription = listen<string>(
      'collection-progress-changed',
      (event) => {
        if (event.payload === item.bvid) void checkpoint.refetch()
      },
    ).catch(() => undefined)
    return () => {
      void subscription.then((stop) => stop?.())
    }
  }, [followed, item.bvid, checkpoint.refetch])
  const [resuming, setResuming] = useState(false)

  const [localSearch, setLocalSearch] = useState('')
  const inputQuery = (searchQuery ?? localSearch).trim()
  const [keyword, setKeyword] = useState(inputQuery)
  const settling = inputQuery !== keyword
  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(inputQuery), inputQuery ? 300 : 0)
    return () => window.clearTimeout(timer)
  }, [inputQuery])
  const [tab, setTab] = useState<'videos' | 'seasons'>('videos')
  const activeTab = inputQuery ? 'videos' : tab
  const epoch = accountEpoch()
  // A -> B -> A is a new browsing session: cached responses may supply data,
  // but only the current session's explicit choice can open an inline panel.
  const partsScope = useMemo(() => ({}), [epoch, mid, inputQuery, activeTab])
  const [partsChoice, setPartsChoice] = useState<{scope:object;bvid:string}>()
  const [error, setError] = useState('')
  const videoResult = useInfiniteQuery({
    queryKey: accountQueryKey('creator-catalog', mid, 'videos', keyword),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => catalog('videos', mid, pageParam, keyword),
    enabled: activeTab === 'videos' && !settling,
    getNextPageParam: (last) =>
      last.page * 30 < last.data.page?.count ? last.page + 1 : undefined,
  })
  const seasonResult = useInfiniteQuery({
    queryKey: accountQueryKey('creator-catalog', mid, 'seasons'),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => catalog('seasons', mid, pageParam),
    enabled: activeTab === 'seasons',
    getNextPageParam: (last) =>
      last.page * 20 < last.data.items_lists?.page?.total
        ? last.page + 1
        : undefined,
  })
  const result = activeTab === 'videos' ? videoResult : seasonResult
  const catalogData = useListDataDuringNavigation(result.data, `${mid}:${activeTab}:${keyword}`)
  const videoData = activeTab === 'videos' ? catalogData : undefined
  const seasonData = activeTab === 'seasons' ? catalogData : undefined
  const loadingCatalog = settling || result.isLoading || Boolean(result.data && !catalogData)
  const videos = useMemo(() => creatorVideos(videoData?.pages), [videoData])
  const seasons = useMemo(() =>
    seasonData?.pages.flatMap(
      (page) => page.data.items_lists?.seasons_list || [],
    ) || [], [seasonData])
  const seasonList = useRef<HTMLDivElement>(null)
  const renderedSeasons = useListRows(seasons, `creator-seasons:${mid}`, { active: activeTab === 'seasons' })
  useListReveal(seasonList, loadingCatalog, seasons.length > 0, activeTab === 'seasons')
  const totalVideos: number | undefined =
    videoData?.pages[0]?.data.page?.count
  const queue = useMemo(() => videos.map(video => creatorVideoRow(video, mid, item.title)), [mid, item.title, videos])
  const expandedBvid = !settling && activeTab === 'videos' && partsChoice?.scope === partsScope &&
    videos.some(video => video.bvid === partsChoice.bvid) ? partsChoice.bvid : undefined
  const partsQuery = useQuery({
    queryKey: accountQueryKey('creator-video-parts', mid, expandedBvid),
    queryFn: () => getVideoParts(expandedBvid!),
    enabled: Boolean(expandedBvid),
    retry: false,
  })
  const parts = expandedBvid ? partsQuery.data : undefined
  const partTracks = parts?.parts.map(part => toTrack(parts,part)) || []
  const queueSource = {
    kind: 'season' as const, title:item.title, collectionRef:item.bvid, creatorMid:mid,
    creatorPage:videoData?.pages.length || 1,creatorTotal:totalVideos || 0,creatorKeyword:keyword,
  }
  useEffect(() => { setError('') }, [keyword, mid])
  const pagination = !loadingCatalog && result.hasNextPage && <LoadMore label="加载更多" busy={result.isFetchingNextPage}
    onLoad={() => void result.fetchNextPage()}/>
  const resumeButton = followed && checkpoint.data && (
    <button
      className="creator-resume"
      disabled={resuming}
      onClick={async () => {
        setResuming(true)
        setError('')
        const scope = accountEpoch(),
          intent = playbackIntent()
        const point = checkpoint.data!
        try {
          let entries = keyword ? [] : creatorVideos(videoResult.data?.pages),
            page = keyword ? 0 : videoResult.data?.pages.length || 0
          let total = keyword ? Infinity : videoResult.data?.pages[0]?.data.page?.count ?? Infinity
          while (
            !entries.some((video) => video.bvid === point.bvid) &&
            entries.length < total
          ) {
            const next = await catalog('videos', mid, ++page)
            if (scope !== accountEpoch() || intent !== playbackIntent()) return
            const rows = next.data.list?.vlist || []
            if (!rows.length) break
            entries.push(...rows)
            total = next.data.page?.count ?? entries.length
          }
          if (!entries.some((video) => video.bvid === point.bvid))
            throw new Error('上次播放的视频已不在这个 UP 主的投稿中')
          const detail = await getVideoParts(point.bvid)
          if (scope !== accountEpoch() || intent !== playbackIntent()) return
          const parts = detail.parts.map((part) => toTrack(detail, part))
          const selected = parts.find((track) => track.source.cid === point.cid)
          if (!selected) throw new Error('上次播放的分 P 已不可用')
          const full = entries.map(video => creatorVideoRow(video, mid, item.title))
          await usePlayerStore.getState().playFromList(
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
            point.positionMs / 1000, true,
          )
        } catch (cause) {
          setError(commandErrorMessage(cause))
        } finally {
          setResuming(false)
        }
      }}
    >
      {resuming ? (
        <LoaderCircle size={17} className="spin" />
      ) : (
        <Play size={17} fill="currentColor" />
      )}
      <span>{resuming ? '加载中' : '继续播放'}</span>
      <small>{formatDuration(checkpoint.data.positionMs / 1000)}</small>
    </button>
  )
  return (
    <section className="creator-page">
      <header className="creator-row creator-header">
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
        <div className="creator-header-actions">
          {!followed && <CreatorFollow item={item} />}
          {followed && <CreatorActions item={saved.data!.items.find(value=>value.bvid===item.bvid)!} folders={(saved.data?.folders || []).filter(f=>f.scope==='creators')}/>}
          {resumeButton}
          <button
            className="collection-icon"
            aria-label="刷新投稿"
            onClick={() => void result.refetch()}
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </header>
      {searchQuery === undefined && <ScopedSearchField creator value={localSearch} onChange={setLocalSearch} className="creator-content-search"/>}
      {inputQuery ? <p className="creator-search-summary" role="status">在这位 UP 主的投稿中搜索“{inputQuery}”{!settling && totalVideos !== undefined ? ` · ${totalVideos} 个结果` : ''}</p> : <SegmentedTabs
        className="listening-tabs"
        tabs={[
          { id: 'videos', label: '全部投稿' },
          { id: 'seasons', label: '合集' },
        ]}
        value={tab}
        onChange={setTab}
        idPrefix="creator"
        panelId="creator-content"
        label="UP 主内容"
      />}
      <div id="creator-content">
        {loadingCatalog && <ListSkeleton label={inputQuery ? '正在搜索这位 UP 主的投稿' : '正在读取投稿'} />}
        {!loadingCatalog && !result.isPending && !result.error && inputQuery && !videos.length && <p className="collection-empty">这位 UP 主暂无匹配的投稿，试试其他关键词。</p>}
        {(result.error || error) && (
          <p role="alert">{commandErrorMessage(result.error || error)}</p>
        )}
        {!settling && (activeTab === 'videos' ? (
          <VideoPartsList
            videoCollection
            totalCount={totalVideos}
            locateCurrent
            tracks={queue}
            queueSource={queueSource}
            loading={loadingCatalog}
            footer={pagination}
            onOpenParts={(track) => {
              setPartsChoice(previous => previous?.scope === partsScope && previous.bvid === track.source.bvid
                ? undefined : {scope:partsScope,bvid:track.source.bvid})
            }}
            renderDetails={track => track.source.bvid === expandedBvid && <section className="collection-nested-parts creator-inline-parts" aria-label={`${track.title}的选集`} data-expanded-for={track.source.bvid}>
              <header><button type="button" className="collection-flat-button" onClick={() => setPartsChoice(undefined)}><ChevronDown size={16}/>收起选集</button></header>
              {partsQuery.isPending && <ListSkeleton label="正在读取选集"/>}
              {partsQuery.isError && <p className="inline-error" role="alert">{commandErrorMessage(partsQuery.error)}<button type="button" className="collection-flat-button" onClick={() => void partsQuery.refetch()}>重试</button></p>}
              {parts && (partTracks.length ? <VideoPartsList tracks={partTracks}
                playbackTracks={seasonPlaybackQueue(queue,partTracks[0],partTracks)} queueSource={queueSource}/> : <p className="batch-message">暂无可播放的分 P</p>)}
            </section>}
          />
        ) : (
          <div ref={seasonList}>{renderedSeasons.rows.map((season) => (
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
              <span className="creator-season-cover"><Artwork src={season.meta.cover}/><CoverCount count={season.meta.total} unit="个视频" single/></span>
              <strong>{season.meta.name}</strong>
            </button>
          ))}{renderedSeasons.more ? <div ref={renderedSeasons.tail} className="list-render-tail" aria-hidden="true"/> : pagination}</div>
        ))}
      </div>
    </section>
  )
}
