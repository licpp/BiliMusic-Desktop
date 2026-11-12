import { CreatorPage } from './CreatorsView'
import type { Track } from '../../domain/track'
import { getSeason, parseSeasonReference, seasonCollection, seasonTracks, seasonVideoRow, videoDetailFromTrack } from '../../services/mediaSources'
import { createPlaylist, saveLibraryTrack, addTracksToPlaylist } from '../../services/desktopApi'
import { accountEpoch } from '../../services/accountScope'
import { SeasonBrowser } from './SeasonBrowser'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowDownUp, Bookmark, Check, ChevronDown, ChevronRight, Folder, FolderInput, ListPlus, LoaderCircle, Play, History, Plus, RefreshCw, Search, X } from 'lucide-react'
import { changeCollection, listCollections, readCollectionProgress, type Collection } from '../../services/collections'
import { commandErrorMessage, getVideoParts, type Playlist } from '../../services/desktopApi'
import { Artwork } from '../../shared/Artwork'
import { ActionMenu } from '../../shared/ActionMenu'
import { toTrack } from '../../services/collectionTrack'
import { MobilePartsPage } from '../library/MobilePartsPage'
import { getVideoPages } from '../../services/videoPages'
import { playbackIntent, resolveSeasonEntry, seasonPlaybackQueue, usePlayerStore } from '../player/playerStore'
import { VideoPartsList } from '../library/VideoPartsList'
import { PlaylistEntry } from '../library/PlaylistEntry'
import { LibraryEntry } from '../library/LibraryEntry'
import { useCompactLayout } from '../../shared/useCompactLayout'
import type { MenuPosition } from '../../shared/useRowContextMenu'
import { formatDuration } from '../../shared/time'
import { isMobile } from '../../services/platform'

const useCollections = () => useQuery({ queryKey: ['collections'], queryFn: listCollections })
type CollectionInfo = Omit<Collection, 'folderId'>

export function CollectionBookmark({ item }: { item: CollectionInfo }) {
  const query=useCollections(),client=useQueryClient(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[optimistic,setOptimistic]=useState<boolean>()
  const saved=query.data?.items.find(i=>i.bvid===item.bvid)
  const active=optimistic??Boolean(saved)
  const toggle=async()=>{
    if(busy)return
    const next=!active;setOptimistic(next);setBusy(true);setError('')
    try{await changeCollection(saved?'remove':'save',item.bvid,'',{...item,folderId:''});await client.invalidateQueries({queryKey:['collections']});setOptimistic(undefined)}
    catch(e){setOptimistic(active);setError(`收藏失败，已恢复原状态：${commandErrorMessage(e)}`)}finally{setBusy(false)}
  }
  return <><button className={`icon-action collection-bookmark ${active?'saved':''}`} aria-busy={busy} disabled={query.isLoading} aria-label={active?'取消收藏合集':'收藏整个合集'} aria-pressed={active} title={active?'取消收藏合集':'收藏整个合集'} onClick={()=>void toggle()}><Bookmark size={18} fill={active?'currentColor':'none'}/></button>{error&&<span role="alert" className="inline-error">{error}</span>}</>
}

export function CollectionMenu({item,contextPosition,onOpen,additionalActions}:{item:CollectionInfo;contextPosition?:{left:number;top:number;nonce:number};onOpen?:()=>void;additionalActions?:(close:()=>void)=>ReactNode}){
  const q=useCollections(),client=useQueryClient(),[picking,setPicking]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const saved=q.data?.items.find(i=>i.bvid===item.bvid)
  const change=async(action:'save'|'move'|'remove',folder='')=>{
    setBusy(true);setError('')
    try{await changeCollection(action,item.bvid,folder,{...item,folderId:folder});await client.invalidateQueries({queryKey:['collections']});setPicking(false)}
    catch(e){setError(commandErrorMessage(e))}finally{setBusy(false)}
  }
  return <><ActionMenu sheet label={`合集操作：${item.title||item.bvid}`} contextPosition={contextPosition}>{close=><>
    {additionalActions?.(close)}
    {onOpen&&<button role="menuitem" onClick={()=>{close();onOpen()}}><Play size={16}/>打开合集</button>}
    <button role="menuitem" onClick={()=>{close();setPicking(true)}}><FolderInput size={16}/>收藏到…</button>
    {saved&&<button role="menuitem" disabled={busy} onClick={()=>{close();void change('remove')}}><Bookmark size={16}/>取消收藏</button>}
  </>}</ActionMenu>{error&&<p className="inline-error" role="alert">{error}</p>}{picking&&<CollectionDialog title="收藏到" onClose={()=>setPicking(false)}><p>{item.title||item.bvid}</p><div className="collection-folder-options">{[{id:'',name:'默认收藏夹'},...(q.data?.folders||[]).filter(f=>f.scope!=='creators')].map(f=><button key={f.id} disabled={busy} onClick={()=>void change(saved?'move':'save',f.id)}><Folder size={17}/><span>{f.name}</span>{saved?.folderId===f.id&&<Check size={17}/>}</button>)}</div><FolderEditor action="create" onDone={()=>void client.invalidateQueries({queryKey:['collections']})}/>{error&&<p role="alert" className="inline-error">{error}</p>}</CollectionDialog>}</>
}

function FolderEditor({action,id='',initial='',onDone,controlledOpen,onClose}:{action:'create'|'rename'|'delete';id?:string;initial?:string;onDone:()=>void;controlledOpen?:boolean;onClose?:()=>void}){
  const [open,setOpen]=useState(false),[name,setName]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const visible=controlledOpen??open
  const close=()=>{setOpen(false);onClose?.()}
  const title=action==='create'?'新建收藏夹':action==='rename'?'重命名收藏夹':'删除收藏夹'
  return <>{controlledOpen===undefined&&<button className="collection-flat-button" aria-label={title} onClick={()=>{setName(initial);setError('');setOpen(true)}}>{action==='create'?<><Plus size={16}/><span>新建收藏夹</span></>:action==='rename'?'重命名':'删除收藏夹'}</button>}{visible&&<CollectionDialog title={title} onClose={close}><form onSubmit={async e=>{e.preventDefault();setBusy(true);try{await changeCollection(action,id,name);close();onDone()}catch(e){setError(commandErrorMessage(e))}finally{setBusy(false)}}}>{action==='delete'?<p>里面的合集会移回默认收藏夹，不会取消收藏。</p>:<input aria-label="收藏夹名称" value={name} maxLength={80} onChange={e=>setName(e.target.value)} placeholder="收藏夹名称"/>}{error&&<p role="alert" className="inline-error">{error}</p>}<footer><button type="button" className="collection-flat-button" onClick={close}>取消</button><button className="collection-primary" type="submit" disabled={busy||(action!=='delete'&&!name.trim())}>{busy?'处理中…':'确认'}</button></footer></form></CollectionDialog>}</>
}

export function CollectionsView({ hideHeading = false, sidebar = false, folderId, linkedFolders = [], onOpenFolder, onOpenLinked, onLinkedRemoved, onSelect, onFolderRemoved }: {
  sidebar?: boolean
  hideHeading?: boolean
  folderId?: string
  linkedFolders?: Playlist[]
  onOpenFolder: (id: string) => void
  onOpenLinked: (id: string) => void
  onLinkedRemoved: (id: string) => void
  onSelect: (item: Collection) => void
  onFolderRemoved?: (id: string) => void
}) {
  const query = useCollections()
  const client = useQueryClient()
  const [expanded, setExpanded] = useState(() => localStorage.getItem('collection-expanded') !== 'false')
  const [searchOpen, setSearchOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const refresh = () => void client.invalidateQueries({ queryKey: ['collections'] })
  const root = folderId === undefined
  const compact = useCompactLayout()
  const folders = (query.data?.folders || []).filter(f=>f.scope!=='creators')
  const move = useMutation({
    mutationFn: async ({ item, target }: { item: Collection; target: string }) => {
      const epoch = accountEpoch()
      await changeCollection('move', item.bvid, target)
      if (epoch === accountEpoch()) await client.invalidateQueries({ queryKey: ['collections'] })
    },
  })
  const moveError = move.error && <button type="button" className="library-toast" role="alert" onClick={move.reset}>
    移动失败：{commandErrorMessage(move.error)}
  </button>
  const items = query.data?.items.filter(item => !item.bvid.startsWith('up:')) || []
  const needle = filter.trim().toLowerCase()
  const matches = (value: string) => value.toLowerCase().includes(needle)
  const visibleItems = items.filter(item => (root && needle ? true : item.folderId === (folderId || '')) && matches(item.title || item.bvid))
  const folder = folders.find(item => item.id === folderId)
  const children = root ? <>
    {folders.filter(item => matches(item.name)).map(folder => {
      const contents = items.filter(item => item.folderId === folder.id)
      const onOpen = () => onOpenFolder(folder.id)
      return <LibraryEntry key={folder.id} title={folder.name} subtitle={`${contents.length} 个收藏`} sidebar={sidebar}
        cover={<Artwork src={contents[0]?.coverUrl} adaptAspect fallback={<Folder aria-hidden="true"/>}/>}
        dropFolderId={folder.id} onOpen={onOpen}
        menu={position => <FolderMenu folder={folder} contextPosition={position} onOpen={onOpen}
          onChanged={refresh} onRemoved={() => onFolderRemoved?.(folder.id)}/>}/>
    })}
    {linkedFolders.filter(item => matches(item.name)).map(item => <PlaylistEntry
      key={item.id} playlist={item} sidebar={sidebar} onOpen={() => onOpenLinked(item.id)} onRemoved={() => onLinkedRemoved(item.id)}
    />)}
  </> : null
  const toggle = () => setExpanded(previous => {
    localStorage.setItem('collection-expanded', String(!previous))
    return !previous
  })
  const entries = <div className="collection-entries">
    {visibleItems.map(item => {
      const title = item.title || `合集 ${item.bvid}`
      const onOpen = () => onSelect(item)
      const canMove = (root || !compact) && !move.isPending && folders.some(folder => folder.id !== item.folderId)
      return <LibraryEntry key={item.bvid} title={title} subtitle={item.uploaderName || (parseSeasonReference(item.bvid) ? '打开查看视频' : '打开查看分 P')} sidebar={sidebar}
        cover={<Artwork src={item.coverUrl} adaptAspect/>} onOpen={onOpen}
        drag={canMove && !isMobile ? { folderId: item.folderId, onMove: target => move.mutate({ item, target }) } : undefined}
        menu={position => <CollectionMenu item={item} contextPosition={position} onOpen={onOpen}/>}/>
    })}
    {children}
  </div>
  if (sidebar) return <section className="collections-sidebar">
    <div className="collections-heading">
      <button type="button" className="collections-collapse" aria-expanded={expanded} onClick={toggle}>
        <span>收藏</span>{expanded ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}
      </button>
      {expanded && <FolderEditor action="create" onDone={refresh}/>}
    </div>
    {expanded && entries}
    {moveError}
  </section>
  return <section className="collections-view collections-embedded">
    <div className={`collections-heading${hideHeading && root ? ' collections-tools-only' : ''}`}>
      {(!hideHeading || !root) && <h3>{folder?.name || '收藏'}</h3>}
      {hideHeading && root && <span className="hub-summary">{items.length + linkedFolders.length} 项收藏{folders.length > 0 && <small> · {folders.length} 个文件夹</small>}</span>}
      <div className="collections-heading-actions">
        <button type="button" className="collection-icon" aria-label="搜索收藏合集" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setFilter('') }}><Search size={18}/></button>
        {root ? <FolderEditor action="create" onDone={refresh}/> : folder && <FolderMenu folder={folder} onChanged={refresh} onRemoved={() => onFolderRemoved?.(folder.id)} />}
      </div>
    </div>
    {searchOpen && <label className="collections-search detail-search"><Search size={16}/>
      <input autoFocus aria-label="搜索收藏合集" placeholder="搜索合集或收藏夹" value={filter} onChange={event => setFilter(event.target.value)}/>
      <button type="button" aria-label="关闭合集搜索" onClick={() => { setFilter(''); setSearchOpen(false) }}><X size={16}/></button>
    </label>}
    {query.error && <p className="inline-error">{commandErrorMessage(query.error)} <button className="collection-flat-button" onClick={() => void query.refetch()}>重试</button></p>}
    {!query.isLoading && !visibleItems.length && (!root || (!folders.some(item => matches(item.name)) && !linkedFolders.some(item => matches(item.name)))) &&
      <p className="collection-empty">{needle ? '没有匹配的收藏' : root ? '点击搜索结果中的书签，收藏喜欢的合集。' : '这个收藏夹还没有合集。'}</p>}
    {entries}
    {moveError}
  </section>
}

type FolderInfo = { id: string; name: string }

function FolderMenu({ folder, contextPosition, onOpen, onChanged, onRemoved }: {
  folder: FolderInfo
  contextPosition?: MenuPosition
  onOpen?: () => void
  onChanged: () => void
  onRemoved: () => void
}) {
  const [action, setAction] = useState<'rename' | 'delete'>()
  return <>
    <ActionMenu sheet label={`收藏夹操作：${folder.name}`} contextPosition={contextPosition}>{close => <>
      {onOpen && <button role="menuitem" onClick={() => { close(); onOpen() }}><Folder size={16}/>打开收藏夹</button>}
      <button role="menuitem" onClick={() => { close(); setAction('rename') }}>重命名收藏夹</button>
      <button role="menuitem" onClick={() => { close(); setAction('delete') }}>删除收藏夹</button>
    </>}</ActionMenu>
    {action && <FolderEditor action={action} id={folder.id} initial={folder.name} controlledOpen
      onClose={() => setAction(undefined)} onDone={() => { if (action === 'delete') onRemoved(); onChanged() }} />}
  </>
}

function StandardCollectionDetail({ item, onBack, onOpenCollection, backLabel = '返回收藏合集', embedded = false, locateCurrent = true, hideBack = false }: {
  item: Collection
  onBack: () => void
  onOpenCollection?: (item: Collection) => void
  backLabel?: string
  embedded?: boolean
  locateCurrent?: boolean
  hideBack?: boolean
}) {
  const reference=parseSeasonReference(item.bvid)
  const bookmarks = useCollections()
  const saved = bookmarks.data?.items.some(collection => collection.bvid === item.bvid)
  const progress = useQuery({
    queryKey: ['collection-progress', accountEpoch(), item.bvid],
    queryFn: () => readCollectionProgress(item.bvid),
    enabled: Boolean(saved),
    staleTime: 0,
  })
  const { refetch: refreshProgress } = progress
  useEffect(() => {
    if (!saved) return
    const stop = listen<string>('collection-progress-changed', event => {
      if (event.payload === item.bvid) void refreshProgress()
    }).catch(() => undefined)
    return () => { void stop.then(unlisten => unlisten?.()) }
  }, [item.bvid, refreshProgress, saved])
  const [resuming, setResuming] = useState(false)
  const forceRefresh = useRef(false)
  const q=useQuery({queryKey:['collection-detail',accountEpoch(),item.bvid],queryFn:async()=>{
    if(reference){
      const refresh = forceRefresh.current
      forceRefresh.current = false
      const catalog = await getSeason(reference.mid, reference.seasonId, refresh)
      return { title: catalog.summary.title, coverUrl: catalog.summary.coverUrl, uploaderName: catalog.summary.uploaderName,
        tracks: catalog.tracks.map(video => seasonVideoRow(video, catalog.summary)), catalog, season: undefined, unavailable: catalog.unavailable }
    }
    const video=await getVideoParts(item.bvid);return {...video,tracks:video.parts.map(p=>toTrack(video,p)),catalog:undefined,unavailable:0}
  }})
  const [filter,setFilter]=useState(''),[searchOpen,setSearchOpen]=useState(false),[seasonOpen,setSeasonOpen]=useState(false),[copying,setCopying]=useState(false),[message,setMessage]=useState(''),[context,setContext]=useState<{left:number;top:number;nonce:number}>()
  useEffect(() => {
    const open = () => { setSearchOpen(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.collection-detail .detail-search input')?.focus()) }
    const filter = (event:Event) => setFilter((event as CustomEvent<string>).detail)
    window.addEventListener('bilimusic-search-collection', open)
    window.addEventListener('bilimusic-filter-collection', filter)
    return () => { window.removeEventListener('bilimusic-search-collection', open); window.removeEventListener('bilimusic-filter-collection', filter) }
  }, [])
  const [openedVideo, setOpenedVideo] = useState<Track>()
  const nested = useQuery({
    queryKey: ['collection-video-parts', accountEpoch(), openedVideo?.source.bvid],
    queryFn: async () => {
      const row = openedVideo!
      const member = q.data?.catalog?.tracks.find(video => video.bvid === row.source.bvid)
      return videoDetailFromTrack(row, member?.parts ?? await getVideoPages(row.source.bvid))
    },
    enabled: Boolean(openedVideo),
  })
  const [reversedCollection, setReversedCollection] = useState<string>()
  const client=useQueryClient()
  useEffect(()=>{const d=q.data;if(!d)return;void invoke('collections_change',{action:'cache',item:{bvid:item.bvid,folderId:item.folderId,title:d.title,coverUrl:d.coverUrl,uploaderName:d.uploaderName}}).then(()=>client.invalidateQueries({queryKey:['collections']})).catch(()=>undefined)},[q.data,client,item.bvid,item.folderId])
  const detail=q.data,player=usePlayerStore.getState()
  const season = detail?.season
  const reversed = reversedCollection === item.bvid
  const tracks = useMemo(() => {
    if (!detail) return []
    return reversed ? [...detail.tracks].reverse() : detail.tracks
  }, [detail, reversed])
  const playbackTracks = useMemo(() => {
    if (!detail?.catalog) return tracks
    const catalog = detail.catalog
    return seasonTracks(reversed ? { ...catalog, tracks: [...catalog.tracks].reverse() } : catalog)
  }, [detail?.catalog, reversed, tracks])
  const queueSource = { kind: reference ? 'season' as const : 'video' as const, title: detail?.title || item.title, collectionRef: item.bvid }
  const unit=reference?'个视频':'个分 P'
  const visibleTracks=tracks.filter(track=>track.title.toLowerCase().includes(filter.toLowerCase()))
  const checkpoint = saved ? progress.data : undefined
  const canResume = checkpoint && playbackTracks.some(track => track.source.bvid === checkpoint.bvid &&
    (track.source.cid === checkpoint.cid || track.resolveParts))
  const resumeTime = checkpoint?.positionMs ? formatDuration(Math.floor(checkpoint.positionMs / 1000)) : ''
  const resumeLabel = resuming ? '正在读取选集' : `继续上次播放${resumeTime ? ` · ${resumeTime}` : ''}`
  const resume = async () => {
    if (!canResume || !checkpoint || resuming) return
    const epoch = accountEpoch()
    const intent = playbackIntent()
    const id = `bilibili:${checkpoint.bvid}:${checkpoint.cid}`
    setResuming(true)
    setMessage('')
    try {
      let queue = playbackTracks
      if (!queue.some(track => track.id === id && !track.resolveParts)) {
        const entry = queue.find(track => track.resolveParts && track.source.bvid === checkpoint.bvid)
        if (entry) {
          const parts = await resolveSeasonEntry(entry)
          const part = parts.find(track => track.id === id)
          if (part) queue = seasonPlaybackQueue(queue, part, parts)
        }
      }
      if (epoch !== accountEpoch() || intent !== playbackIntent()) return
      if (!queue.some(track => track.id === id && !track.resolveParts)) {
        setMessage('上次播放的分 P 已不在这个合集里。')
        return
      }
      await player.playFromList(queue, id, queueSource, checkpoint.positionMs / 1000)
    } catch (error) { setMessage(commandErrorMessage(error)) }
    finally { setResuming(false) }
  }
  const copy=async()=>{
    const epoch=accountEpoch();setCopying(true);setMessage('')
    try{const list=await createPlaylist(detail?.title||item.title||'B 站合集');const ids:string[]=[];for (const entry of playbackTracks) {
        if (epoch !== accountEpoch()) return
        const parts = entry.resolveParts ? await resolveSeasonEntry(entry) : [entry]
        for (const track of parts) {
          if (epoch !== accountEpoch()) return
          ids.push((await saveLibraryTrack(track)).id)
        }
      }if(epoch!==accountEpoch())return;await addTracksToPlaylist(list.id,ids,true);await client.invalidateQueries({queryKey:['playlists']});setMessage('已复制到我的歌单')}
    catch(error){setMessage(commandErrorMessage(error))}finally{setCopying(false)}
  }
  return <section className="collection-detail">
    {!embedded && !hideBack && <button className="collection-flat-button collection-back" onClick={onBack}><ArrowLeft size={17}/>{backLabel}</button>}
    <header onContextMenu={event => {
      event.preventDefault()
      setContext({ left: event.clientX, top: event.clientY, nonce: Date.now() })
    }}>
      <Artwork src={detail?.coverUrl || item.coverUrl}/>
      <div>
        <h2>{detail?.title || item.title || 'B 站合集'}</h2>
        <p>{detail?.uploaderName || item.uploaderName}{detail && <span> · {tracks.length} {unit}</span>}</p>
      </div>
      <CollectionBookmark item={item}/>
    </header>
    {season && <button className="mobile-row-action" onClick={() => {
      if (onOpenCollection) onOpenCollection(seasonCollection(season))
      else setSeasonOpen(true)
    }}><span>所属合集 · {season.title}</span><span>›</span></button>}
    <div className="collection-detail-toolbar">
      <div className="collection-play-actions">
        <button className="collection-primary" disabled={!tracks.length} onClick={()=>void player.playFromList(playbackTracks, tracks[0].id, queueSource)}><Play size={15}/>播放全部</button>
        {canResume && <button className="collection-resume" disabled={resuming} aria-busy={resuming} aria-label={resumeLabel} title={resumeLabel} onClick={() => void resume()}>
          {resuming ? <LoaderCircle size={15} className="spin"/> : <History size={15}/>}续播
        </button>}
      </div>
      <div className="collection-list-actions">
        <button className="collection-icon collection-order" aria-label={reversed ? '恢复原顺序' : '倒序排列'} aria-pressed={reversed} title={reversed ? '恢复原顺序' : '倒序排列'} disabled={tracks.length < 2} onClick={() => setReversedCollection(reversed ? undefined : item.bvid)}><ArrowDownUp size={16}/><span>{reversed ? '倒序' : '原序'}</span></button>
        <button className="collection-icon" aria-label="搜索列表" aria-expanded={searchOpen} onClick={()=>{setSearchOpen(v=>!v);setFilter('')}}><Search size={18}/></button>
        <CollectionMenu item={item} contextPosition={context} additionalActions={close => <>
          <button role="menuitem" disabled={!tracks.length} onClick={()=>{player.enqueue(playbackTracks);close()}}><ListPlus size={16}/>全部加入队列</button>
          <button role="menuitem" disabled={!tracks.length||copying} onClick={()=>{close();void copy()}}><Plus size={16}/>{copying?'正在复制…':'复制为本地歌单'}</button>
          <button role="menuitem" disabled={q.isFetching} onClick={()=>{if (reference) forceRefresh.current = true; else void getVideoParts(item.bvid, true); void q.refetch();close()}}><RefreshCw size={16}/>刷新列表</button>
        </>}/>
      </div>
    </div>
    {searchOpen&&<label className="collections-search detail-search"><Search size={16}/><input aria-label="搜索列表" placeholder="搜索此合集中的内容" value={filter} onChange={e=>setFilter(e.target.value)}/><button aria-label="关闭搜索" onClick={()=>{setSearchOpen(false);setFilter('')}}><X size={16}/></button></label>}
    {copying&&<p className="batch-message" role="status">正在复制到我的歌单…</p>}
    {message&&<p className="batch-message" role="status">{message}</p>}
    {q.isLoading&&<p>正在读取列表…</p>}{q.error&&<p className="inline-error">{commandErrorMessage(q.error)}<button className="collection-flat-button" onClick={()=>void q.refetch()}>重试</button></p>}
    {!q.isLoading&&!q.error&&!tracks.length&&<p className="collection-empty">暂无可播放内容</p>}
    {Boolean(detail?.unavailable)&&<p className="batch-message">有 {detail?.unavailable} 个视频暂不可用，已保留其余内容。</p>}
    <VideoPartsList tracks={tracks} visibleTracks={visibleTracks} videoCollection={Boolean(reference)} locateCurrent={locateCurrent}
      playbackTracks={playbackTracks} queueSource={queueSource} onOpenParts={reference ? setOpenedVideo : undefined}/>
    {openedVideo && (() => {
      const video = nested.data
      const parts = video?.parts.map(part => toTrack(video, part)) ?? []
      const close = () => setOpenedVideo(undefined)
      const queue = parts.length ? seasonPlaybackQueue(playbackTracks, parts[0], parts) : playbackTracks
      if (isMobile && video && parts.length > 1) return <MobilePartsPage detail={video} onBack={close} playbackTracks={queue} queueSource={queueSource} showSeasonLink={false}/>
      return <CollectionDialog title={openedVideo.title} onClose={close}>
        {nested.isError ? <button className="load-more" onClick={() => void nested.refetch()}>{commandErrorMessage(nested.error)} · 重试</button> :
          !video ? <p className="batch-message">正在读取选集…</p> :
          parts.length > 1 ? <VideoPartsList locateCurrent tracks={parts} playbackTracks={queue} queueSource={queueSource}/> : <p className="batch-message">这个视频可以直接播放。</p>}
      </CollectionDialog>
    })()}
    {seasonOpen&&season&&<SeasonBrowser summary={season} onClose={()=>setSeasonOpen(false)}/>}
  </section>
}

export function CollectionDetail(props: Parameters<typeof StandardCollectionDetail>[0]) {
  return props.item.bvid.startsWith('up:') ? <CreatorPage item={props.item} onOpen={props.onOpenCollection}/> : <StandardCollectionDetail {...props}/>
}
