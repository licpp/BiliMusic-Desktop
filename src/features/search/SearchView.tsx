import { useListRows } from '../../shared/useListRows'
import { useListDataDuringNavigation, useListReveal } from '../../shared/useListMotion'
import { ListSkeleton } from '../../shared/ListSkeleton'
import { accountQueryKey } from '../../services/queryKeys'
import { canManageVisibility, videoScope } from '../../domain/contentVisibility'
import { chooseDownload } from '../downloads/downloadRequest'
import { downloadSelectionMessage, prepareDownloadSelection } from '../downloads/downloadSelection'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { VideoResultRow } from '../../shared/VideoResultRow'
import { CreatorsView } from '../collections/CreatorsView'
import { SwipeTabPages } from '../../shared/SwipeTabPages'
import { isMobile } from '../../services/platform'
import { MobilePartsPage } from '../library/MobilePartsPage'
import { toTrack } from '../../services/collectionTrack'
import { listCollections, type Collection, type Collections } from '../../services/collections'
import { CollectionBookmark, CollectionMenu } from '../collections/CollectionsView'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleAlert, Columns2, Download, Heart, ListPlus, ListVideo, LoaderCircle, Play, RefreshCw, SearchX, Waves } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { getSeason, seasonTracks } from '../../services/mediaSources'
import { adoptSeasonQueue, playbackIntent, seasonPlaybackQueue, usePlayerStore } from '../player/playerStore'
import { commandErrorMessage, getVideoParts, inDesktopShell, saveLibraryTrack, searchBilibili, toggleStoredFavorite } from '../../services/desktopApi'
import type { BiliSearchItem, BiliVideoAccess, BiliVideoParts } from '../../domain/bilibili'
import { retryOnceUnlessBiliPaused } from '../../services/biliRequestStatus'
import { useVisibleVideoPages } from '../../shared/useVisibleVideoPages'
import { LoadMore } from '../../shared/LoadMore'
import { Artwork } from '../../shared/Artwork'
import { VideoPartsList } from '../library/VideoPartsList'
import { chooseVideoPlaylist } from '../library/trackActionStore'
import './search-results.css'

type ExpandedState = { open?: boolean; loading?: boolean; detail?: BiliVideoParts; error?: string; request?: number }
const layoutPreferenceKey = 'bilibili-search-results-layout'
const minimumTwoColumnWidth = isMobile ? 620 : 720

function readColumnPreference() {
  try { return localStorage.getItem(layoutPreferenceKey) === 'columns' }
  catch { return false }
}

function VideoSearchView({ query, active = true, onCollectionOpen }: { query: string; active?: boolean; onCollectionOpen?: (item: Collection) => void }) {
  const [columns, setColumns] = useState(readColumnPreference)
  const [roomForColumns, setRoomForColumns] = useState(false)
  const twoColumns = columns && roomForColumns
  const [partsPage, setPartsPage] = useState<BiliVideoParts | null>(null)
  const [partsDialog, setPartsDialog] = useState<BiliSearchItem | null>(null)
  const partsTrigger = useRef<HTMLButtonElement>(null)
  const [context,setContext]=useState<{bvid:string;left:number;top:number;nonce:number}>()
  const [expanded, setExpanded] = useState<Record<string, ExpandedState>>({})
  const [favoriteState, setFavoriteState] = useState<Record<string, boolean>>({})
  const [actionNotice, setActionNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  useEffect(() => {
    if (actionNotice?.kind !== 'info') return
    const timer = window.setTimeout(() => setActionNotice(current => current === actionNotice ? null : current), 2400)
    return () => window.clearTimeout(timer)
  }, [actionNotice])
  const [downloadResolving,setDownloadResolving]=useState<string>()
  const downloadIntent=useRef(0)
  const client = useQueryClient()
  useQuery({ queryKey: accountQueryKey('collections'), queryFn: listCollections, enabled: active })
  const resultsSection = useRef<HTMLElement>(null)
  const resultList = useRef<HTMLDivElement>(null)
  const play = usePlayerStore((state) => state.playFromList)
  const enqueue = usePlayerStore((state) => state.enqueue)
  const selection = useRef(0)
  const browsing = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => () => { selection.current++; browsing.current++; downloadIntent.current++ }, [])
  const result = useInfiniteQuery({ queryKey: accountQueryKey('bilibili-search', query), initialPageParam: 1, queryFn: ({ pageParam }) => searchBilibili(query, pageParam), getNextPageParam: (last) => last.items.length && last.page * last.pageSize < last.total ? last.page + 1 : undefined, enabled: Boolean(query) && active, staleTime: Infinity, refetchOnMount: false, retry: retryOnceUnlessBiliPaused })
  const searchData = useListDataDuringNavigation(result.data, query)
  const loadingResults = result.isLoading || Boolean(result.data && !searchData)
  const items = [...new Map(searchData?.pages.flatMap((page) => page.items).map((item) => [item.bvid, item]) || []).values()]
  const showingResults = loadingResults || items.length > 0
  const rendered = useListRows(items, `search-videos:${query}`, { active })
  useListReveal(resultList, loadingResults, items.length > 0, active)
  useLayoutEffect(() => {
    const section = resultsSection.current
    if (!active || !showingResults || !section) return
    const measure = () => setRoomForColumns(section.clientWidth >= minimumTwoColumnWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(section)
    return () => observer.disconnect()
  }, [active, showingResults])
  useEffect(() => {
    if (!active) {
      partsTrigger.current = null
      setPartsDialog(null)
    } else if (!partsDialog) {
      const trigger = partsTrigger.current
      partsTrigger.current = null
      if (trigger?.isConnected && !trigger.closest('[hidden],[inert]')) trigger.focus({ preventScroll: true })
    }
  }, [active, partsDialog])
  const toggleLayout = () => {
    const next = !columns
    setColumns(next)
    try { localStorage.setItem(layoutPreferenceKey, next ? 'columns' : 'list') }
    catch { /* Layout switching also works without persistent storage. */ }
  }
  const add = async (track: Track, favorite = false) => {
    const previous = favoriteState[track.id] ?? track.liked
    if (favorite) setFavoriteState(value => ({ ...value, [track.id]: !previous }))
    try {
      const stored = await saveLibraryTrack(track)
      if (favorite) { const liked = await toggleStoredFavorite(stored.id); setFavoriteState(value => ({ ...value, [track.id]: liked })); usePlayerStore.getState().updateTrack({ ...stored, liked }) }
      else enqueue([stored])
      await client.invalidateQueries({ queryKey: accountQueryKey('library') })
      if (favorite) { await client.invalidateQueries({ queryKey: accountQueryKey('playlists') }); await client.invalidateQueries({ queryKey: accountQueryKey('home-recent') }) }
      setActionNotice({ kind: 'info', text: favorite ? '已更新喜欢状态' : '已加入播放队列' })
    } catch (error) { if (favorite) setFavoriteState(value => ({ ...value, [track.id]: previous })); setActionNotice({ kind: 'error', text: favorite ? `收藏失败，已恢复原状态：${commandErrorMessage(error)}` : commandErrorMessage(error) }) }
  }

  const selectResult = async (item: BiliSearchItem, partCount?: number) => {
    if (partCount === 1) return
    const request = ++browsing.current
    const epoch = accountEpoch()
    const inline = !isMobile && !twoColumns
    const existing = expanded[item.bvid]
    if (twoColumns) setPartsDialog(item)
    if (existing?.detail && (!isMobile || twoColumns)) {
      if (inline || existing.error) {
        setExpanded(state => ({ ...state, [item.bvid]: { detail: existing.detail, open: inline ? !existing.open : existing.open } }))
      }
      return
    }
    setExpanded(state => ({ ...state, [item.bvid]: { ...state[item.bvid], request, loading: true, error: undefined } }))
    try {
      const detail = existing?.detail || await getVideoParts(item.bvid)
      if (epoch !== accountEpoch()) return
      const current = request === browsing.current && activeRef.current
      setExpanded(state => {
        const row = state[item.bvid]
        if (row?.request !== request) return state
        return { ...state, [item.bvid]: { detail, open: current && inline ? detail.parts.length > 1 : row.open } }
      })
      if (current && isMobile && !twoColumns && detail.parts.length > 1) setPartsPage(detail)
    } catch (cause) {
      if (epoch !== accountEpoch()) return
      setExpanded(state => {
        const row = state[item.bvid]
        if (row?.request !== request) return state
        return { ...state, [item.bvid]: { ...row, request: undefined, loading: false, error: commandErrorMessage(cause) } }
      })
    }
  }
  const resultAction = async (item: BiliSearchItem, action: 'playlist' | 'queue' | 'play' | 'download', useSeason = true) => {
    const request = action === 'play' ? ++selection.current : selection.current
    const downloadRequest=action==='download'?++downloadIntent.current:0
    if(action==='download')setDownloadResolving(item.bvid)
    const epoch = accountEpoch()
    const before = playbackIntent()
    try {
      const detail = expanded[item.bvid]?.detail || await getVideoParts(item.bvid)
      if (epoch !== accountEpoch()) return
      setExpanded(state => ({ ...state, [item.bvid]: { ...state[item.bvid], detail } }))
      const tracks = detail.parts.map(part => toTrack(detail, part))
      if (action === 'download') {
        const current = () => epoch === accountEpoch() && downloadRequest === downloadIntent.current
        const result = await prepareDownloadSelection(tracks, undefined, current)
        if (!result || !current()) return
        if (!result.tracks.length) setActionNotice({ kind: 'error', text: downloadSelectionMessage(result.failed, 0) })
        else chooseDownload(result.tracks)
      }
      else if (action === 'playlist') chooseVideoPlaylist(detail)
      else if (action === 'queue') { enqueue(tracks); setActionNotice({ kind: 'info', text: '已加入播放队列' }) }
      else {
        if (request !== selection.current || before !== playbackIntent()) return
        const selected = tracks[0]
        if (!selected) { setActionNotice({ kind: 'error', text: '暂无可播放内容' }); return }
        const saved = () => client.getQueryData<Collections>(accountQueryKey('collections'))?.items ?? []
        void play(tracks, selected.id, { kind: 'video', title: detail.title, collectionRef: detail.bvid, visibilityManaged: canManageVisibility(videoScope(detail.bvid), saved(), tracks) })
        const intent = playbackIntent()
        if (useSeason && detail.season) {
          const { uploaderId, id } = detail.season
          void getSeason(uploaderId, id).then(season => {
            if (epoch !== accountEpoch() || request !== selection.current) return
            const reference = `season:${uploaderId}:${id}`
            adoptSeasonQueue(intent, selected.id, seasonPlaybackQueue(seasonTracks(season), selected, tracks), season.summary.title, reference, canManageVisibility(reference, saved()))
          }).catch(() => undefined)
        }
      }
    } catch (cause) { if(epoch===accountEpoch()&&(action!=='download'||downloadRequest===downloadIntent.current))setActionNotice({ kind: 'error', text: commandErrorMessage(cause) }) }
    finally{if(epoch===accountEpoch()&&action==='download'&&downloadRequest===downloadIntent.current)setDownloadResolving(undefined)}
  }

  if (!inDesktopShell) return <EmptyState icon={Waves} title="桌面搜索已准备好" detail="请使用 npm run tauri dev 启动原生窗口，浏览器预览不会直接访问平台接口。" />
  if (loadingResults) return <section ref={resultsSection} className="search-results video-result-layout" data-columns={twoColumns || undefined}><ListSkeleton wide label="正在搜索视频" /></section>
  if (result.isError && !items.length) return <EmptyState icon={CircleAlert} title="搜索暂时不可用" detail={commandErrorMessage(result.error)} action={<button onClick={() => result.refetch()}><RefreshCw size={15} />重新尝试</button>} />
  if (!items.length) return <EmptyState icon={SearchX} title="没有找到结果" detail="可以尝试歌曲名、歌手名或 BV 号" />

  const renderParts = (detail: BiliVideoParts) => detail.parts.length ? <VideoPartsList
    queueSource={{ kind: 'video', title: detail.title }} tracks={detail.parts.map(part => toTrack(detail, part))}
    renderActions={track => {
      const liked = favoriteState[track.id] ?? track.liked
      return <>
        <button className="icon-action" aria-label="加入队列" title="加入队列" onClick={() => void add(track)}><ListPlus size={16} /></button>
        <button className={`icon-action${liked ? ' liked' : ''}`} aria-label="切换喜欢" title="切换喜欢" onClick={() => void add(track, true)}><Heart size={16} fill={liked ? 'currentColor' : 'none'} /></button>
      </>
    }} /> : <p className="batch-message">暂无可播放的分 P</p>
  const dialogState = partsDialog ? expanded[partsDialog.bvid] : undefined
  const notice = actionNotice && <button className="library-toast" data-tone={actionNotice.kind} role={actionNotice.kind === 'error' ? 'alert' : 'status'} onClick={() => setActionNotice(null)}>{actionNotice.text}</button>

  return <section ref={resultsSection} className="search-results video-result-layout" aria-label="视频搜索结果" data-columns={twoColumns || undefined}>
    <header className="search-results-toolbar">
      <span>约 {searchData?.pages[0]?.total.toLocaleString()} 个视频</span>
      {(!isMobile || roomForColumns) && <button type="button" className="search-layout-button" disabled={!roomForColumns} aria-pressed={twoColumns} onClick={toggleLayout} title={columns ? '切换为单列列表' : '切换为双列列表'}>
        <Columns2 size={16} aria-hidden="true" />双列
      </button>}
    </header>
    {!partsDialog && notice}
    <div className="video-result-list" ref={resultList}>{rendered.rows.map((item) => {
      const state = expanded[item.bvid]
      const open = !twoColumns && Boolean(state?.open)
      return <SearchResultCard key={item.bvid} bvid={item.bvid} active={active} detail={state?.detail} open={open} onContextMenu={e=>{e.preventDefault(); if (!isMobile) setContext({bvid:item.bvid,left:e.clientX,top:e.clientY,nonce:Date.now()})}}>{(partCount, current, access) => <>
        <VideoResultRow title={item.title || item.bvid} coverUrl={item.coverUrl} durationSeconds={item.durationSeconds} count={partCount}
          uploaderName={item.uploaderName} playCount={item.playCount} publishedAt={item.publishedAt} access={access} currentId={current ? item.bvid : undefined}
          onContextMenu={event => { if (isMobile) { event.preventDefault(); void selectResult(item, partCount) } }}
          onClick={() => void resultAction(item, 'play')} actions={<>
            {!isMobile && (partCount ?? 0) > 1 && <button type="button" className="icon-action" aria-label={open ? '收起分 P' : '查看分 P'} title={open ? '收起分 P' : '查看分 P'}
              aria-haspopup={twoColumns ? 'dialog' : undefined} aria-expanded={twoColumns ? undefined : open} aria-controls={open ? `search-parts-${item.bvid}` : undefined}
              disabled={!twoColumns && state?.loading} onClick={event => {
                if (twoColumns) partsTrigger.current = event.currentTarget
                void selectResult(item, partCount)
              }}>
              {twoColumns ? <ListVideo size={17}/> : state?.loading ? <LoaderCircle className="spin" size={17}/> : <ChevronDown size={17} className={open ? 'rotated' : undefined}/>}
            </button>}
            <CollectionBookmark item={item}/>
            <CollectionMenu item={item} onOpen={onCollectionOpen ? () => onCollectionOpen({ ...item, folderId: '' }) : undefined} contextPosition={context?.bvid===item.bvid?context:undefined} additionalActions={(close)=><>
              {isMobile && (partCount ?? 0) > 1 && <button role="menuitem" onClick={() => { close(); void selectResult(item, partCount) }}><ChevronDown size={16}/>查看分 P</button>}
              <button role="menuitem" disabled={downloadResolving===item.bvid} onClick={() => { close(); void resultAction(item, 'download') }}>{downloadResolving===item.bvid?<LoaderCircle size={16} className="spin"/>:<Download size={16}/>}{(partCount??0)>1?'下载全部分 P…':'下载音频…'}</button>
              <button role="menuitem" onClick={() => { close(); void resultAction(item, 'playlist') }}><ListPlus size={16} />收藏到歌单…</button>
              <button role="menuitem" onClick={() => { close(); void resultAction(item, 'queue') }}><ListPlus size={16} />加入播放队列</button>
              <button role="menuitem" onClick={() => { close(); void resultAction(item, 'play') }}><Play size={16} />{open ? '播放全部分 P' : '播放'}</button>
            </>}/>
          </>}/>
        {!twoColumns && state?.error && <div className="inline-error"><CircleAlert size={14} />{state.error}</div>}
        {open && state?.detail && <div id={`search-parts-${item.bvid}`}>{renderParts(state.detail)}</div>}
      </>}</SearchResultCard>
    })}{rendered.more && <div ref={rendered.tail} className="list-render-tail" aria-hidden="true"/>}</div>
    {active && partsPage && <MobilePartsPage key={partsPage.bvid} detail={partsPage} onBack={() => setPartsPage(null)}/>}
    {active && partsDialog && <CollectionDialog title="选集" className="search-parts-dialog" onClose={() => setPartsDialog(null)}>
      <div className="search-parts-summary"><Artwork src={partsDialog.coverUrl}/><strong>{partsDialog.title || partsDialog.bvid}</strong></div>
      {dialogState?.error ? <div className="search-parts-message" role="alert">
        <span>{dialogState.error}</span><button className="collection-flat-button" onClick={() => void selectResult(partsDialog)}><RefreshCw size={15}/>重试</button>
      </div> : dialogState?.detail ? renderParts(dialogState.detail) : <p className="search-parts-message" role="status"><LoaderCircle size={16} className="spin"/>正在加载分 P</p>}
      {notice}
    </CollectionDialog>}
    {result.hasNextPage && !rendered.more && <LoadMore busy={result.isFetchingNextPage} automatic={active && searchData === result.data && !result.isFetchNextPageError} onLoad={() => void result.fetchNextPage()} label={result.isFetchNextPageError ? '重试加载' : '加载更多结果'}/>}
    {result.isFetchNextPageError && <p className="inline-error">{commandErrorMessage(result.error)}</p>}
  </section>
}


function SearchResultCard({ bvid, active, detail, open, onContextMenu, children }: {
  bvid: string; active: boolean; detail?: BiliVideoParts; open: boolean; onContextMenu: (event: MouseEvent) => void
  children: (partCount: number | undefined, current: boolean, access?: BiliVideoAccess) => ReactNode
}) {
  const current = usePlayerStore(state => !open && state.current?.source.bvid === bvid)
  const { ref, pages, access } = useVisibleVideoPages<HTMLElement>(bvid, active && !detail, true)
  return <article ref={ref} className="video-result-card" data-expanded={open || undefined} onContextMenu={onContextMenu}>{children(detail?.parts.length ?? pages?.length, current, detail ? detail.access : access)}</article>
}

function EmptyState({ icon: Icon, title, detail, spinning, action }: { icon: typeof Waves; title: string; detail: string; spinning?: boolean; action?: ReactNode }) {
  return <div className="search-empty"><span><Icon className={spinning ? 'spin' : ''} /></span><h2>{title}</h2><p>{detail}</p>{action}</div>
}

const searchTabs = [{ id: 'video', label: '视频' }, { id: 'creator', label: 'UP 主' }] as const

export function SearchView(props: { query: string; active?: boolean; onCollectionOpen?: (item: Collection) => void }) {
  const [tab, setTab] = useState<'video' | 'creator'>('video')
  return <div className="search-view-tabs"><SwipeTabPages className="listening-tabs" tabs={searchTabs} value={tab} onChange={setTab}
    idPrefix="search-kind" panelId="search-kind-panel" label="搜索类型"
    renderPanel={(kind, paneActive) => kind === 'video'
      ? <VideoSearchView {...props} active={Boolean(props.active) && paneActive} />
      : <CreatorsView query={props.query} onOpen={item => props.onCollectionOpen?.(item)} />} /></div>
}
