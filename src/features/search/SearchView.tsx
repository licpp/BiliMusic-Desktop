import { toTrack } from '../../services/collectionTrack'
import type { Collection } from '../../services/collections'
import { CollectionBookmark, CollectionMenu } from '../collections/CollectionsView'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, CircleAlert, Heart, Link2, ListPlus, LoaderCircle, Play, RefreshCw, SearchX, Waves } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Track } from '../../domain/track'
import { usePlayerStore } from '../player/playerStore'
import { commandErrorMessage, getVideoParts, inDesktopShell, saveLibraryTrack, searchBilibili, toggleStoredFavorite, type BiliSearchItem, type BiliVideoParts } from '../../services/desktopApi'
import { formatDuration } from '../../shared/time'
import { formatPlayCount } from '../../shared/count'
import { Artwork } from '../../shared/Artwork'
import { LinkedFolderPicker } from '../library/LinkedFolderView'
import { VideoPartsList } from '../library/VideoPartsList'
import { chooseTrackPlaylist } from '../library/trackActionStore'

type ExpandedState = { open?: boolean; loading?: boolean; detail?: BiliVideoParts; error?: string }

export function SearchView({ query, active = true, onCollectionOpen }: { query: string; active?: boolean; onCollectionOpen?: (item: Collection) => void }) {
  const [context,setContext]=useState<{bvid:string;left:number;top:number;nonce:number}>()
  const [linking, setLinking] = useState<string>()
  const [expanded, setExpanded] = useState<Record<string, ExpandedState>>({})
  const [favoriteState, setFavoriteState] = useState<Record<string, boolean>>({})
  const [actionError, setActionError] = useState('')
  const client = useQueryClient()
  const play = usePlayerStore((state) => state.playFromList)
  const enqueue = usePlayerStore((state) => state.enqueue)
  const playAll = usePlayerStore((state) => state.playAll)
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

  const selectResult = async (item: BiliSearchItem, expandOnly = false) => {
    const existing = expanded[item.bvid]
    if (existing?.loading) return
    if (existing?.detail) {
      if (!expandOnly && existing.detail.parts.length === 1) {
        const tracks = existing.detail.parts.map(part => toTrack(existing.detail!, part))
        void play(tracks, tracks[0].id)
      } else {
        setExpanded(state => ({ ...state, [item.bvid]: { ...state[item.bvid], open: !state[item.bvid]?.open } }))
      }
      return
    }
    setExpanded((state) => ({ ...state, [item.bvid]: { loading: true, open: true } }))
    try {
      const detail = await getVideoParts(item.bvid)
      const playSingle = !expandOnly && detail.parts.length === 1
      setExpanded((state) => ({ ...state, [item.bvid]: { detail, open: !playSingle } }))
      if (playSingle) {
        const tracks = detail.parts.map(part => toTrack(detail, part))
        void play(tracks, tracks[0].id)
      }
    } catch (error) {
      setExpanded((state) => ({ ...state, [item.bvid]: { error: commandErrorMessage(error) } }))
    }
  }
  const resultAction = async (item: BiliSearchItem, action: 'playlist' | 'queue' | 'play') => {
    try {
      const detail = expanded[item.bvid]?.detail || await getVideoParts(item.bvid)
      setExpanded((state) => ({ ...state, [item.bvid]: { ...state[item.bvid], detail } }))
      const tracks = detail.parts.map((part) => toTrack(detail, part))
      if (action === 'playlist') chooseTrackPlaylist(tracks)
      else if (action === 'queue') { enqueue(tracks); setActionError('已加入播放队列') }
      else await playAll(tracks)
    } catch (cause) { setActionError(commandErrorMessage(cause)) }
  }

  if (!inDesktopShell) return <EmptyState icon={Waves} title="桌面搜索已准备好" detail="请使用 npm run tauri dev 启动原生窗口，浏览器预览不会直接访问平台接口。" />
  if (result.isLoading) return <EmptyState spinning icon={LoaderCircle} title="正在搜索" detail={`正在寻找与“${query}”相关的内容`} />
  if (result.isError && !items.length) return <EmptyState icon={CircleAlert} title="搜索暂时不可用" detail={commandErrorMessage(result.error)} action={<button onClick={() => result.refetch()}><RefreshCw size={15} />重新尝试</button>} />
  if (!items.length) return <EmptyState icon={SearchX} title="没有找到结果" detail="可以尝试歌曲名、歌手名或 BV 号" />

  return <section className="search-results">
    <header><div><span className="eyebrow">SEARCH</span><h2>“{query}”</h2><p>找到约 {result.data?.pages[0].total.toLocaleString()} 个视频，点击条目可解析分 P。</p></div></header>
    {actionError && <button className="library-toast" onClick={() => setActionError('')}>{actionError}</button>}
    <div className="result-list">{items.map((item) => {
      const state = expanded[item.bvid]
      const open = Boolean(state?.open)
      return <article className={open ? 'result-card expanded' : 'result-card'} key={item.bvid} onContextMenu={e=>{e.preventDefault();setContext({bvid:item.bvid,left:e.clientX,top:e.clientY,nonce:Date.now()})}}>
        <div className="search-result-heading"><button type="button" className="result-main" onClick={() => void selectResult(item)}>
          <span className="result-cover"><Artwork src={item.coverUrl} /><i><Play size={17} fill="currentColor" /></i></span>
          <span className="result-copy"><strong>{item.title}</strong><small>{item.uploaderName} · {formatPlayCount(item.playCount)} 次播放</small><em>{item.description || '暂无简介'}</em></span>
          <span className="result-duration">{formatDuration(item.durationSeconds)}</span>
        </button><button type="button" className="icon-action result-expand" aria-label={`${open ? '收起' : '展开'}分 P：${item.title}`} aria-expanded={open} aria-controls={`search-parts-${item.bvid}`} disabled={state?.loading} onClick={() => void selectResult(item, true)}>
          {state?.loading ? <LoaderCircle className="spin" size={19} /> : open ? <ChevronDown size={19} /> : <ChevronRight size={19} />}
        </button><CollectionBookmark item={item}/><CollectionMenu item={item} onOpen={onCollectionOpen ? () => onCollectionOpen({ ...item, folderId: '' }) : undefined} contextPosition={context?.bvid===item.bvid?context:undefined} additionalActions={(close)=><>
          <button role="menuitem" onClick={() => { close(); void resultAction(item, 'playlist') }}><ListPlus size={16} />{open ? '全部加入歌单…' : '加入歌单…'}</button>
          <button role="menuitem" onClick={() => { close(); setLinking(item.bvid) }}><Link2 size={16} />添加到关联收藏夹…</button>
          <button role="menuitem" onClick={() => { close(); void resultAction(item, 'queue') }}><ListPlus size={16} />加入播放队列</button>
          <button role="menuitem" onClick={() => { close(); void resultAction(item, 'play') }}><Play size={16} />{open ? '播放全部分 P' : '播放'}</button>
        </>}/></div>
        {state?.error && <div className="inline-error"><CircleAlert size={14} />{state.error}</div>}

        {open && state?.detail && <div id={`search-parts-${item.bvid}`}><VideoPartsList tracks={state.detail.parts.map(part => toTrack(state.detail!, part))} renderActions={track => <>
          <button className="icon-action" aria-label="加入队列" title="加入队列" onClick={() => void add(track)}><ListPlus size={16} /></button>
          <button className={`icon-action${(favoriteState[track.id] ?? track.liked) ? ' liked' : ''}`} aria-label="切换喜欢" title="切换喜欢" onClick={() => void add(track, true)}><Heart size={16} fill={(favoriteState[track.id] ?? track.liked) ? 'currentColor' : 'none'} /></button>
        </>} />{!state.detail.parts.length && <p className="batch-message">暂无可播放的分 P</p>}</div>}
      </article>
    })}</div>
    {active && linking && <LinkedFolderPicker bvid={linking} onClose={() => setLinking(undefined)} />}
    {result.hasNextPage && <button className="load-more" disabled={result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>{result.isFetchingNextPage ? '加载中…' : '加载更多结果'}</button>}
    {result.isFetchNextPageError && <p className="inline-error">{commandErrorMessage(result.error)}</p>}
  </section>
}


function EmptyState({ icon: Icon, title, detail, spinning, action }: { icon: typeof Waves; title: string; detail: string; spinning?: boolean; action?: ReactNode }) {
  return <div className="search-empty"><span><Icon className={spinning ? 'spin' : ''} /></span><h2>{title}</h2><p>{detail}</p>{action}</div>
}
