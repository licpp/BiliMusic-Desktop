import { isMobile } from '../../services/platform'
import { MobilePartsPage } from '../library/MobilePartsPage'
import { toTrack } from '../../services/collectionTrack'
import type { Collection } from '../../services/collections'
import { CollectionBookmark, CollectionMenu } from '../collections/CollectionsView'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleAlert, Heart, Link2, ListPlus, LoaderCircle, Play, RefreshCw, SearchX, Waves } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { getSeason, seasonTracks } from '../../services/mediaSources'
import { adoptSeasonQueue, playbackIntent, seasonPlaybackQueue, usePlayerStore } from '../player/playerStore'
import { commandErrorMessage, getVideoParts, inDesktopShell, saveLibraryTrack, searchBilibili, toggleStoredFavorite, type BiliSearchItem, type BiliVideoParts } from '../../services/desktopApi'
import { formatDuration } from '../../shared/time'
import { formatPlayCount } from '../../shared/count'
import { useVisibleVideoPages } from '../../shared/useVisibleVideoPages'
import { LoadMore } from '../../shared/LoadMore'
import { PlayingMark } from '../../shared/PlayingMark'
import { Artwork } from '../../shared/Artwork'
import { LinkedFolderPicker } from '../library/LinkedFolderView'
import { VideoPartsList } from '../library/VideoPartsList'
import { chooseTrackPlaylist } from '../library/trackActionStore'

type ExpandedState = { open?: boolean; loading?: boolean; detail?: BiliVideoParts; error?: string }

export function SearchView({ query, active = true, onCollectionOpen }: { query: string; active?: boolean; onCollectionOpen?: (item: Collection) => void }) {
  const [partsPage, setPartsPage] = useState<BiliVideoParts | null>(null)
  const [context,setContext]=useState<{bvid:string;left:number;top:number;nonce:number}>()
  const [linking, setLinking] = useState<string>()
  const [expanded, setExpanded] = useState<Record<string, ExpandedState>>({})
  const [favoriteState, setFavoriteState] = useState<Record<string, boolean>>({})
  const [actionError, setActionError] = useState('')
  const client = useQueryClient()
  const play = usePlayerStore((state) => state.playFromList)
  const enqueue = usePlayerStore((state) => state.enqueue)
  const selection = useRef(0)
  const browsing = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => () => { selection.current++; browsing.current++ }, [])
  const result = useInfiniteQuery({ queryKey: ['bilibili-search', query], initialPageParam: 1, queryFn: ({ pageParam }) => searchBilibili(query, pageParam), getNextPageParam: (last) => last.items.length && last.page * last.pageSize < last.total ? last.page + 1 : undefined, enabled: Boolean(query) && active, staleTime: Infinity, refetchOnMount: false, retry: (failures, error) => failures < 1 && !/\b412\b/.test(commandErrorMessage(error)) })
  const items = [...new Map(result.data?.pages.flatMap((page) => page.items).map((item) => [item.bvid, item]) || []).values()]
  const add = async (track: Track, favorite = false) => {
    const previous = favoriteState[track.id] ?? track.liked
    if (favorite) setFavoriteState(value => ({ ...value, [track.id]: !previous }))
    try {
      const stored = await saveLibraryTrack(track)
      if (favorite) { const liked = await toggleStoredFavorite(stored.id); setFavoriteState(value => ({ ...value, [track.id]: liked })); usePlayerStore.getState().updateTrack({ ...stored, liked }) }
      else enqueue([stored])
      await client.invalidateQueries({ queryKey: ['library'] })
      if (favorite) { await client.invalidateQueries({ queryKey: ['playlists'] }); await client.invalidateQueries({ queryKey: ['home-recent'] }) }
      setActionError(favorite ? '已更新喜欢状态' : '已加入播放队列')
    } catch (error) { if (favorite) setFavoriteState(value => ({ ...value, [track.id]: previous })); setActionError(favorite ? `收藏失败，已恢复原状态：${commandErrorMessage(error)}` : commandErrorMessage(error)) }
  }

  const selectResult = async (item: BiliSearchItem, partCount?: number) => {
    if (partCount === 1) return
    const request = ++browsing.current
    const existing = expanded[item.bvid]
    if (existing?.detail && !isMobile) {
      setExpanded(state => ({ ...state, [item.bvid]: { detail: existing.detail, open: !existing.open } }))
      return
    }
    setExpanded(state => ({ ...state, [item.bvid]: { ...state[item.bvid], loading: true, error: undefined } }))
    try {
      const detail = existing?.detail || await getVideoParts(item.bvid)
      if (request !== browsing.current || !activeRef.current) {
        setExpanded(state => ({ ...state, [item.bvid]: { ...state[item.bvid], detail, loading: false } }))
        return
      }
      setExpanded(state => ({ ...state, [item.bvid]: { detail, open: !isMobile && detail.parts.length > 1 } }))
      if (isMobile && detail.parts.length > 1) setPartsPage(detail)
    } catch (cause) {
      setExpanded(state => ({ ...state, [item.bvid]: { error: commandErrorMessage(cause) } }))
    }
  }
  const resultAction = async (item: BiliSearchItem, action: 'playlist' | 'queue' | 'play', useSeason = true) => {
    const request = action === 'play' ? ++selection.current : selection.current
    const epoch = accountEpoch()
    const before = playbackIntent()
    try {
      const detail = expanded[item.bvid]?.detail || await getVideoParts(item.bvid)
      if (epoch !== accountEpoch()) return
      setExpanded(state => ({ ...state, [item.bvid]: { ...state[item.bvid], detail } }))
      const tracks = detail.parts.map(part => toTrack(detail, part))
      if (action === 'playlist') chooseTrackPlaylist(tracks)
      else if (action === 'queue') { enqueue(tracks); setActionError('已加入播放队列') }
      else {
        if (request !== selection.current || before !== playbackIntent()) return
        const selected = tracks[0]
        if (!selected) { setActionError('暂无可播放内容'); return }
        void play(tracks, selected.id, { kind: 'video', title: detail.title, collectionRef: detail.bvid })
        const intent = playbackIntent()
        if (useSeason && detail.season) {
          const { uploaderId, id } = detail.season
          void getSeason(uploaderId, id).then(season => {
            if (epoch !== accountEpoch() || request !== selection.current) return
            adoptSeasonQueue(intent, selected.id, seasonPlaybackQueue(seasonTracks(season), selected, tracks), season.summary.title, `season:${uploaderId}:${id}`)
          }).catch(() => undefined)
        }
      }
    } catch (cause) { setActionError(commandErrorMessage(cause)) }
  }

  if (!inDesktopShell) return <EmptyState icon={Waves} title="桌面搜索已准备好" detail="请使用 npm run tauri dev 启动原生窗口，浏览器预览不会直接访问平台接口。" />
  if (result.isLoading) return <EmptyState spinning icon={LoaderCircle} title="正在搜索" detail={`正在寻找与“${query}”相关的内容`} />
  if (result.isError && !items.length) return <EmptyState icon={CircleAlert} title="搜索暂时不可用" detail={commandErrorMessage(result.error)} action={<button onClick={() => result.refetch()}><RefreshCw size={15} />重新尝试</button>} />
  if (!items.length) return <EmptyState icon={SearchX} title="没有找到结果" detail="可以尝试歌曲名、歌手名或 BV 号" />

  return <section className="search-results">
    <header><div><span className="eyebrow">SEARCH</span><h2>“{query}”</h2><p>找到约 {result.data?.pages[0].total.toLocaleString()} 个视频，{isMobile ? '点条目播放，长按查看视频详情。' : '点条目播放，点箭头展开详情。'}</p></div></header>
    {actionError && <button className="library-toast" onClick={() => setActionError('')}>{actionError}</button>}
    <div className="result-list">{items.map((item) => {
      const state = expanded[item.bvid]
      const open = Boolean(state?.open)
      return <SearchResultCard key={item.bvid} bvid={item.bvid} active={active} count={state?.detail?.parts.length} open={open} onContextMenu={e=>{e.preventDefault(); if (!isMobile) setContext({bvid:item.bvid,left:e.clientX,top:e.clientY,nonce:Date.now()})}}>{(partCount, current) => <>
        <div className="search-result-heading playing-row" data-current-row={current ? item.bvid : undefined}><button type="button" className="result-main" aria-current={current ? 'true' : undefined} onContextMenu={event => { if (isMobile) { event.preventDefault(); void selectResult(item, partCount) } }} onClick={() => void resultAction(item, 'play')}>
          <span className="result-cover"><Artwork src={item.coverUrl} /><i><Play size={17} fill="currentColor" /></i>{current && <PlayingMark/>}</span>
          <span className="result-copy"><strong>{item.title}</strong><small>{item.uploaderName} · {formatPlayCount(item.playCount)} 次播放</small><em>{item.description || '暂无简介'}</em></span>
          <span className="result-duration">{formatDuration(item.durationSeconds)}</span>
        </button>{!isMobile && (partCount ?? 0) > 1 && <button type="button" className="icon-action result-expand" aria-label={open ? '收起分 P' : '查看分 P'} title={open ? '收起分 P' : '查看分 P'} aria-expanded={isMobile ? undefined : open} disabled={state?.loading} onClick={() => void selectResult(item, partCount)}>{state?.loading ? <LoaderCircle className="spin" size={17}/> : <ChevronDown size={17} className={open ? 'rotated' : undefined}/>}</button>}<CollectionBookmark item={item}/><CollectionMenu item={item} onOpen={onCollectionOpen ? () => onCollectionOpen({ ...item, folderId: '' }) : undefined} contextPosition={context?.bvid===item.bvid?context:undefined} additionalActions={(close)=><>
          <button role="menuitem" onClick={() => { close(); void resultAction(item, 'playlist') }}><ListPlus size={16} />{open ? '全部加入歌单…' : '加入歌单…'}</button>
          <button role="menuitem" onClick={() => { close(); setLinking(item.bvid) }}><Link2 size={16} />添加到关联收藏夹…</button>
          <button role="menuitem" onClick={() => { close(); void resultAction(item, 'queue') }}><ListPlus size={16} />加入播放队列</button>
          <button role="menuitem" onClick={() => { close(); void resultAction(item, 'play') }}><Play size={16} />{open ? '播放全部分 P' : '播放'}</button>
        </>}/></div>
        {state?.error && <div className="inline-error"><CircleAlert size={14} />{state.error}</div>}

        {open && state?.detail && <div id={`search-parts-${item.bvid}`}><VideoPartsList queueSource={{ kind: 'video', title: state.detail.title }} tracks={state.detail.parts.map(part => toTrack(state.detail!, part))} renderActions={track => <>
          <button className="icon-action" aria-label="加入队列" title="加入队列" onClick={() => void add(track)}><ListPlus size={16} /></button>
          <button className={`icon-action${(favoriteState[track.id] ?? track.liked) ? ' liked' : ''}`} aria-label="切换喜欢" title="切换喜欢" onClick={() => void add(track, true)}><Heart size={16} fill={(favoriteState[track.id] ?? track.liked) ? 'currentColor' : 'none'} /></button>
        </>} />{!state.detail.parts.length && <p className="batch-message">暂无可播放的分 P</p>}</div>}
      </>}</SearchResultCard>
    })}</div>
    {active && partsPage && <MobilePartsPage key={partsPage.bvid} detail={partsPage} onBack={() => setPartsPage(null)}/>}
    {active && linking && <LinkedFolderPicker bvid={linking} onClose={() => setLinking(undefined)} />}
    {result.hasNextPage && <LoadMore busy={result.isFetchingNextPage} automatic={active && !result.isFetchNextPageError} onLoad={() => void result.fetchNextPage()} label={result.isFetchNextPageError ? '重试加载' : '加载更多结果'}/>}
    {result.isFetchNextPageError && <p className="inline-error">{commandErrorMessage(result.error)}</p>}
  </section>
}


function SearchResultCard({ bvid, active, count, open, onContextMenu, children }: {
  bvid: string; active: boolean; count?: number; open: boolean; onContextMenu: (event: MouseEvent) => void
  children: (partCount: number | undefined, current: boolean) => ReactNode
}) {
  const current = usePlayerStore(state => !open && state.current?.source.bvid === bvid)
  const { ref, pages } = useVisibleVideoPages(bvid, active && count === undefined && !isMobile)
  return <div ref={ref} className={open ? 'result-card expanded' : 'result-card'} onContextMenu={onContextMenu}>{children(count ?? pages?.length, current)}</div>
}

function EmptyState({ icon: Icon, title, detail, spinning, action }: { icon: typeof Waves; title: string; detail: string; spinning?: boolean; action?: ReactNode }) {
  return <div className="search-empty"><span><Icon className={spinning ? 'spin' : ''} /></span><h2>{title}</h2><p>{detail}</p>{action}</div>
}
