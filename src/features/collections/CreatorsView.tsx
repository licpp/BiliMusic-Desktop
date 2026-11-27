import { useListRows } from '../../shared/useListRows'
import { useListDataDuringNavigation, useListReveal } from '../../shared/useListMotion'
import { ListSkeleton } from '../../shared/ListSkeleton'
import { accountQueryKey } from '../../services/queryKeys'
import { VideoResultRow } from '../../shared/VideoResultRow'
import { ScopedSearchField } from '../search/ScopedSearchField'
import { FolderMenu } from './CollectionFolderControls'
import { CreatorFolderArtwork } from './CreatorFolderArtwork'
import { LibraryEntry } from '../library/LibraryEntry'
import { CreatorActions, CreatorManager } from './CreatorTools'
import { formatAudienceCount } from '../../shared/count'
import { accountEpoch } from '../../services/accountScope'
import { formatDuration } from '../../shared/time'
import { invoke } from '@tauri-apps/api/core'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { UserRound, ArrowLeft, ChevronDown, ChevronRight, Bookmark, Check, RefreshCw, Play, LoaderCircle } from 'lucide-react'
import {
  changeCollection,
  listCollections,
  type Collection,
} from '../../services/collections'
import { commandErrorMessage, getVideoParts } from '../../services/desktopApi'
import { creatorVideoRow } from '../../services/mediaSources'
import { seasonPlaybackQueue } from '../player/playerStore'
import { toTrack } from '../../services/collectionTrack'
import { VideoPartsList } from '../library/VideoPartsList'
import { useSeasonCover } from '../../shared/useSeasonCover'
import { Artwork } from '../../shared/Artwork'
import { LoadMore } from '../../shared/LoadMore'
import { SwipeTabPages } from '../../shared/SwipeTabPages'
import { createCollectionResume, isCurrentCollectionResume, resolveCreatorContinuation, resumeCreatorUploads, type OpenCollection } from './creatorContinuation'
import { useCollectionProgress } from './useCollectionProgress'

type Creator = {
  mid: number
  uname: string
  upic: string
  usign?: string
  fans?: number
}
type Catalog = { data: any; page: number }
function CreatorSeasonRow({ collection, count, onOpen }: { collection: Collection; count: number; onOpen?: OpenCollection }) {
  const image = useSeasonCover(collection.bvid, collection.coverUrl)
  return <div className="video-result-card">
    <VideoResultRow title={collection.title} coverUrl={image.cover} coverRef={image.ref} count={count} countUnit="个视频"
      onClick={() => onOpen?.(collection)}/>
  </div>
}

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
  actionsHost,
  folderId, onOpenFolder, onFolderRemoved,
}: {
  folderId?:string;onOpenFolder?:(id:string)=>void;onFolderRemoved?:(id:string)=>void
  query?: string
  onOpen: (item: Collection) => void
  followed?: boolean
  sidebar?: boolean
  actionsHost?: HTMLElement | null
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
    <section className={`creators-view${sidebar ? ' creators-sidebar sidebar-section' : ''}`}>
      {followed && root && <CreatorManager sidebar={sidebar} expanded={expanded} actionsHost={actionsHost} onToggle={()=>setExpanded(value=>{localStorage.setItem('creators-expanded',String(!value));return !value})} items={items}/>}
      {followed&&!root&&<div className="collections-heading"><h3>{folders.find(f=>f.id===selectedFolder)?.name||'关注文件夹'}</h3><div className="collections-heading-actions">{!folderId&&<button className="collection-icon" aria-label="返回关注" onClick={()=>setGroup('all')}><ArrowLeft size={18}/></button>}{folders.filter(f=>f.id===selectedFolder).map(folder=><FolderMenu key={folder.id} creator folder={folder} onChanged={()=>void saved.refetch()} onRemoved={()=>{setGroup('all');onFolderRemoved?.(folder.id)}}/>)}</div></div>}
      <div hidden={sidebar && !expanded}>
      {followed&&root&&folders.map(folder=>{
        const members = items.filter(item => item.folderId === folder.id)
        return <LibraryEntry key={folder.id} title={folder.name} subtitle={`${members.length} 位 UP 主`} sidebar={sidebar} cover={<CreatorFolderArtwork id={folder.id}/>} onOpen={()=>openFolder(folder.id)} menu={position=><FolderMenu creator folder={folder} contextPosition={position} onOpen={()=>openFolder(folder.id)} onChanged={()=>void saved.refetch()} onRemoved={()=>{if(selectedFolder===folder.id)setGroup('all');onFolderRemoved?.(folder.id)}}/>}/>
      })}
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
        <p className={sidebar ? 'sidebar-empty' : 'batch-message'}>
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

const creatorTabs = [
  { id: 'videos', label: '全部投稿' },
  { id: 'seasons', label: '合集' },
] as const

export function CreatorPage({
  item,
  onOpen,
  searchQuery,
  active = true,
}: {
  item: Collection
  onOpen?: OpenCollection
  searchQuery?: string
  active?: boolean
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
  const checkpoint = useCollectionProgress(item.bvid, active && Boolean(followed))
  const [resuming, setResuming] = useState(false)
  const resumeVersion = useRef(0)
  useLayoutEffect(() => { setResuming(false); return () => { resumeVersion.current++ } }, [active, item.bvid])

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
  const videoData = useListDataDuringNavigation(videoResult.data, `${mid}:videos:${keyword}`)
  const seasonData = useListDataDuringNavigation(seasonResult.data, `${mid}:seasons`)
  const loadingVideos = settling || videoResult.isLoading || Boolean(videoResult.data && !videoData)
  const loadingSeasons = seasonResult.isLoading || Boolean(seasonResult.data && !seasonData)
  const videos = useMemo(() => creatorVideos(videoData?.pages), [videoData])
  const seasons = useMemo(() =>
    seasonData?.pages.flatMap(
      (page) => page.data.items_lists?.seasons_list || [],
    ) || [], [seasonData])
  const seasonList = useRef<HTMLDivElement>(null)
  const renderedSeasons = useListRows(seasons, `creator-seasons:${mid}`, { active: activeTab === 'seasons' })
  useListReveal(seasonList, loadingSeasons, seasons.length > 0, activeTab === 'seasons')
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
  const videoPagination = !loadingVideos && videoResult.hasNextPage && <LoadMore label="加载更多" busy={videoResult.isFetchingNextPage}
    onLoad={() => void videoResult.fetchNextPage()}/>
  const seasonPagination = !loadingSeasons && seasonResult.hasNextPage && <LoadMore label="加载更多" busy={seasonResult.isFetchingNextPage}
    onLoad={() => void seasonResult.fetchNextPage()}/>
  const resumeButton = followed && checkpoint.data && (
    <button
      className="creator-resume"
      disabled={resuming}
      onClick={async () => {
        const point = checkpoint.data
        if (!active || !point || resuming) return
        const request = createCollectionResume(point)
        const version = ++resumeVersion.current
        const present = () => version === resumeVersion.current && request.account === accountEpoch()
        const current = () => present() && isCurrentCollectionResume(request)
        setResuming(true)
        setError('')
        try {
          const target = await resolveCreatorContinuation(point, item, current)
          if (!target || !current()) return
          if ('collection' in target && onOpen) {
            onOpen(target.collection, request)
            return
          }
          const detail = 'detail' in target ? target.detail : await getVideoParts(point.bvid)
          await resumeCreatorUploads(item, point, detail, current, page => catalog('videos', mid, page), keyword ? [] : videoResult.data?.pages)
        } catch (cause) {
          if (current()) setError(commandErrorMessage(cause))
        } finally {
          if (present()) setResuming(false)
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
  const renderVideosPane = () => <>
    {loadingVideos && <ListSkeleton label={inputQuery ? '正在搜索这位 UP 主的投稿' : '正在读取投稿'} />}
    {!loadingVideos && !videoResult.isPending && !videoResult.error && inputQuery && !videos.length && <p className="collection-empty">这位 UP 主暂无匹配的投稿，试试其他关键词。</p>}
    {videoResult.error && (
      <p role="alert">{commandErrorMessage(videoResult.error)}</p>
    )}
    {!settling && (
      <VideoPartsList
        videoCollection
        totalCount={totalVideos}
        locateCurrent
        tracks={queue}
        queueSource={queueSource}
        loading={loadingVideos}
        footer={videoPagination}
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
    )}
  </>

  const renderSeasonsPane = () => <>
    {loadingSeasons && <ListSkeleton label="正在读取合集" />}
    {!loadingSeasons && !seasonResult.isPending && !seasonResult.error && !seasons.length && <p className="collection-empty">这位 UP 主暂时还没有合集。</p>}
    {seasonResult.error && (
      <p role="alert">{commandErrorMessage(seasonResult.error)}</p>
    )}
    <div ref={seasonList} className="video-result-layout video-result-list">{renderedSeasons.rows.map((season) => {
      const collection = { bvid: `season:${mid}:${season.meta.season_id}`, folderId: '', title: season.meta.name, coverUrl: season.meta.cover, uploaderName: item.title }
      return <CreatorSeasonRow collection={collection} count={season.meta.total} onOpen={onOpen} key={collection.bvid}/>
    })}{renderedSeasons.more ? <div ref={renderedSeasons.tail} className="list-render-tail" aria-hidden="true"/> : seasonPagination}</div>
  </>

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
      {error && <p role="alert">{error}</p>}
      {searchQuery === undefined && <ScopedSearchField creator value={localSearch} onChange={setLocalSearch} className="creator-content-search"/>}
      {inputQuery ? <>
        <p className="creator-search-summary" role="status">在这位 UP 主的投稿中搜索“{inputQuery}”{!settling && totalVideos !== undefined ? ` · ${totalVideos} 个结果` : ''}</p>
        <div id="creator-content">{renderVideosPane()}</div>
      </> : <SwipeTabPages
        className="listening-tabs"
        tabs={creatorTabs}
        value={tab}
        onChange={setTab}
        idPrefix="creator"
        panelId="creator-content"
        label="UP 主内容"
        renderPanel={(kind) => kind === 'videos' ? renderVideosPane() : renderSeasonsPane()}
      />}
    </section>
  )
}
