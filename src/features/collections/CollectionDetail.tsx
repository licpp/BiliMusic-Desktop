import { trackHidden } from '../../domain/contentVisibility'
import { useManagedVisibilityScope } from '../../shared/useManagedVisibilityScope'
import { useVisibilityRules } from '../../services/contentVisibility'
import { accountQueryKey } from '../../services/queryKeys'
import { useQuery,useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft,History,ListPlus,LoaderCircle,Play,Plus,RefreshCw,Search,X } from 'lucide-react'
import { useEffect,useMemo,useRef,useState } from 'react'
import type { Track } from '../../domain/track'
import { filterSeasonSection,seasonResumeSelection } from '../../domain/seasonSections'
import { accountEpoch } from '../../services/accountScope'
import { listCollections,readCollectionProgress,type Collection } from '../../services/collections'
import { toTrack } from '../../services/collectionTrack'
import { addTracksToPlaylist,commandErrorMessage,createPlaylist,getVideoParts,saveLibraryTrack } from '../../services/desktopApi'
import { sortList,sortTracks } from '../../services/listOrdering'
import { getSeason,parseSeasonReference,seasonCollection,seasonTracks,seasonVideoRow,videoDetailFromTrack } from '../../services/mediaSources'
import { isMobile } from '../../services/platform'
import { getVideoPages } from '../../services/videoPages'
import { Artwork } from '../../shared/Artwork'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { ListSort,useListSort } from '../../shared/ListSort'
import { MobilePage } from '../../shared/MobilePage'
import { PublishedDate } from '../../shared/PublishedDate'
import { VideoAccessBadge } from '../../shared/VideoAccessBadge'
import { SeasonSections,useSeasonSection } from '../../shared/SeasonSections'
import { formatDuration } from '../../shared/time'
import { MobilePartsContent } from '../library/MobilePartsContent'
import { VideoPartsList } from '../library/VideoPartsList'
import { prepareListPlayback } from '../player/listPlayback'
import { offlineEntries, useOfflinePlayback } from '../player/offlinePlayback'
import { playbackIntent,resolveSeasonEntry,seasonPlaybackQueue,usePlayerStore } from '../player/playerStore'
import { CollectionBookmark } from './CollectionBookmark'
import { CollectionMenu } from './CollectionMenu'
import { CreatorPage } from './CreatorsView'

const useCollections = () => useQuery({queryKey:accountQueryKey('collections'),queryFn:listCollections})
function StandardCollectionDetail({ item, onBack, onOpenCollection, backLabel = '返回收藏合集', embedded = false, locateCurrent = true, hideBack = false, searchQuery }: {
  item: Collection
  onBack: () => void
  onOpenCollection?: (item: Collection) => void
  backLabel?: string
  embedded?: boolean
  locateCurrent?: boolean
  hideBack?: boolean
  searchQuery?: string
}) {
  const offline = useOfflinePlayback()
  const visibilityRules=useVisibilityRules()
  const candidateVisibilityScope=item.bvid.startsWith('season:')?item.bvid:`video:${item.bvid}`
  const reference=parseSeasonReference(item.bvid)
  const bookmarks = useCollections()
  const saved = bookmarks.data?.items.some(collection => collection.bvid === item.bvid)
  const progress = useQuery({
    queryKey: accountQueryKey('collection-progress', item.bvid),
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
  const resumeVersion = useRef(0)
  useEffect(() => { setResuming(false); return () => { resumeVersion.current++ } }, [item.bvid])
  const forceRefresh = useRef(false)
  const q=useQuery({queryKey:accountQueryKey('collection-detail', item.bvid),queryFn:async()=>{
    if(reference){
      const refresh = forceRefresh.current
      forceRefresh.current = false
      const catalog = await getSeason(reference.mid, reference.seasonId, refresh)
      return { access: undefined, publishedAt: undefined, title: catalog.summary.title, coverUrl: catalog.summary.coverUrl, uploaderName: catalog.summary.uploaderName,
        tracks: catalog.tracks.map(video => seasonVideoRow(video, catalog.summary)), catalog, season: undefined, unavailable: catalog.unavailable }
    }
    const video=await getVideoParts(item.bvid);return {...video,tracks:video.parts.map(p=>toTrack(video,p)),catalog:undefined,unavailable:0}
  }})
  const [filter,setFilter]=useState(''),[searchOpen,setSearchOpen]=useState(false),[seasonOpen,setSeasonOpen]=useState(false),[copying,setCopying]=useState(false),[message,setMessage]=useState(''),[context,setContext]=useState<{left:number;top:number;nonce:number}>()
  const [openedVideo, setOpenedVideo] = useState<Track>()
  const nested = useQuery({
    queryKey: accountQueryKey('collection-video-parts', openedVideo?.source.bvid),
    queryFn: async () => {
      const row = openedVideo!
      const member = q.data?.catalog?.tracks.find(video => video.bvid === row.source.bvid)
      return videoDetailFromTrack(row, member?.parts ?? await getVideoPages(row.source.bvid))
    },
    enabled: Boolean(openedVideo),
  })
  const detailSort=useListSort(`collection:${item.bvid}`)
  const client=useQueryClient()
  useEffect(()=>{const d=q.data;if(!d)return;void invoke('collections_change',{action:'cache',item:{bvid:item.bvid,folderId:item.folderId,title:d.title,coverUrl:d.coverUrl,uploaderName:d.uploaderName}}).then(()=>client.invalidateQueries({queryKey:accountQueryKey('collections')})).catch(()=>undefined)},[q.data,client,item.bvid,item.folderId])
  const detail=q.data,player=usePlayerStore.getState()
  const visibilityScope=useManagedVisibilityScope(candidateVisibilityScope,detail?.tracks ?? [])
  const isHidden=(track:Track)=>Boolean(visibilityScope && trackHidden(track,visibilityScope,visibilityRules))
  const season = detail?.season
  const sections = detail?.catalog?.sections
  const [selectedSection,setSelectedSection] = useSeasonSection(item.bvid,sections)
  const {tracks,playbackTracks,resumePlaybackTracks} = useMemo(() => {
    if (!detail) return {tracks:[],playbackTracks:[],resumePlaybackTracks:[]}
    const sort = (rows:Track[]) => detailSort.rule.startsWith('plays:')
      ? sortTracks(rows,detailSort.rule,detailSort.dates,detailSort.playCounts)
      : sortList(rows,detailSort.rule,track=>({id:track.id,name:track.title,date:track.publishedAt||detailSort.dates[track.source.bvid],playCount:track.playCount??detailSort.playCounts[track.source.bvid]}))
    const project = (rows:Track[]) => {
      const catalog = detail.catalog
      if (!catalog) return rows
      const ordered=rows.map(track=>catalog.tracks.find(video=>video.bvid===track.source.bvid)).filter((v):v is NonNullable<typeof v>=>Boolean(v))
      return seasonTracks({...catalog,tracks:ordered})
    }
    const tracks=sort(filterSeasonSection(detail.tracks,sections,selectedSection))
    return {tracks,playbackTracks:project(tracks),resumePlaybackTracks:project(selectedSection ? sort(detail.tracks) : tracks)}
  }, [detail, sections, selectedSection, detailSort.rule, detailSort.dates, detailSort.playCounts])
  const queueSource = { kind: reference ? 'season' as const : 'video' as const, title: detail?.title || item.title, collectionRef: item.bvid, visibilityManaged: Boolean(visibilityScope) }
  const unit=reference?'个视频':'个分 P'
  const visibleTracks=tracks.filter(track=>track.title.toLowerCase().includes((searchQuery ?? filter).toLowerCase()))
  const checkpoint = saved ? progress.data : undefined
  const canPlay = (track: Track) => !isHidden(track) && offlineEntries(track, offline).some(part => !isHidden(part))
  const canResume = checkpoint && resumePlaybackTracks.some(track => track.source.bvid === checkpoint.bvid &&
    (track.source.cid === checkpoint.cid || track.resolveParts)) && resumePlaybackTracks.some(canPlay)
  const resumeTime = checkpoint?.positionMs ? formatDuration(Math.floor(checkpoint.positionMs / 1000)) : ''
  const resumeLabel = resuming ? '正在读取选集' : `继续上次播放${resumeTime ? ` · ${resumeTime}` : ''}`
  const resume = async () => {
    if (!canResume || !checkpoint || resuming) return
    const epoch = accountEpoch()
    const intent = playbackIntent()
    const version = ++resumeVersion.current
    const active = () => version === resumeVersion.current && epoch === accountEpoch()
    const current = () => active() && intent === playbackIntent()
    setResuming(true)
    setMessage('')
    try {
      const prepared = await prepareListPlayback(resumePlaybackTracks, checkpoint, resolveSeasonEntry,
        current, t => !isHidden(t), offline.offline ? track => offlineEntries(track, offline) : undefined)
      if (!current()) return
      if (!prepared) { setMessage('没有可继续播放的内容。'); return }
      const selection = seasonResumeSelection(prepared.queue,prepared.sourceTrackId ?? prepared.trackId,sections,selectedSection)
      setSelectedSection(selection.sectionId)
      setFilter('')
      await player.playFromList(selection.tracks, prepared.trackId, queueSource, prepared.startAt, true)
    } catch (error) { if (current()) setMessage(commandErrorMessage(error)) }
    finally { if (active()) setResuming(false) }
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
      }if(epoch!==accountEpoch())return;await addTracksToPlaylist(list.id,ids,true);await client.invalidateQueries({queryKey:accountQueryKey('playlists')});setMessage('已复制到我的歌单')}
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
        <p>{detail?.uploaderName || item.uploaderName}{detail && <span> · {tracks.length} {unit}</span>}</p>{!reference && <PublishedDate value={detail?.publishedAt}/>}<VideoAccessBadge access={detail?.access}/>
      </div>
      <CollectionBookmark item={item}/>
    </header>
    {season && <button className="mobile-row-action" onClick={() => {
      if (onOpenCollection) onOpenCollection(seasonCollection(season))
      else setSeasonOpen(true)
    }}><span>所属合集 · {season.title}</span><span>›</span></button>}
    <VideoPartsList managementTracks={detail?.tracks} tracks={tracks} visibleTracks={visibleTracks} videoCollection={Boolean(reference)} locateCurrent={locateCurrent}
      playbackTracks={playbackTracks} queueSource={queueSource} onOpenParts={reference ? setOpenedVideo : undefined}
      toolbar={{ primary: <>
        <button className="collection-primary" aria-label="播放全部" title="播放全部" disabled={!playbackTracks.some(canPlay)} onClick={()=>void player.playFromList(playbackTracks, playbackTracks[0].id, queueSource)}><Play size={15}/>播放全部</button>
        {canResume && <button className="collection-resume" disabled={resuming} aria-busy={resuming} aria-label={resumeLabel} title={resumeLabel} onClick={() => void resume()}>
          {resuming ? <LoaderCircle size={15} className="spin"/> : <History size={15}/>}<span>续播</span>
        </button>}
      </>, actions: <>
        <ListSort entity={`collection:${item.bvid}`}/>
        {searchQuery === undefined && <button className="collection-icon" aria-label="搜索列表" aria-expanded={searchOpen} onClick={()=>{setSearchOpen(v=>!v);setFilter('')}}><Search size={18}/></button>}
        <span className="collection-browse-menu"><CollectionMenu item={item} contextPosition={context} additionalActions={close => <>
          <button role="menuitem" disabled={!playbackTracks.some(canPlay)} onClick={()=>{player.enqueue(playbackTracks.filter(canPlay));close()}}><ListPlus size={16}/>全部加入队列</button>
          <button role="menuitem" disabled={!tracks.length||copying} onClick={()=>{close();void copy()}}><Plus size={16}/>{copying?'正在复制…':'复制为本地歌单'}</button>
          <button role="menuitem" disabled={q.isFetching} onClick={()=>{if (reference) forceRefresh.current = true; else void getVideoParts(item.bvid, true); void q.refetch();close()}}><RefreshCw size={16}/>刷新列表</button>
        </>}/></span>
      </> }}
      listHeader={<>
        <SeasonSections sections={sections} selected={selectedSection} onChange={setSelectedSection}/>
        {searchQuery === undefined && searchOpen&&<label className="collections-search detail-search"><Search size={16}/><input aria-label="搜索列表" placeholder="搜索此合集中的内容" value={filter} onChange={e=>setFilter(e.target.value)}/><button aria-label="关闭搜索" onClick={()=>{setSearchOpen(false);setFilter('')}}><X size={16}/></button></label>}
        {copying&&<p className="batch-message" role="status">正在复制到我的歌单…</p>}
        {message&&<p className="batch-message" role="status">{message}</p>}
        {q.isLoading&&<p>正在读取列表…</p>}{q.error&&<p className="inline-error">{commandErrorMessage(q.error)}<button className="collection-flat-button" onClick={()=>void q.refetch()}>重试</button></p>}
        {!q.isLoading&&!q.error&&!tracks.length&&<p className="collection-empty">暂无可播放内容</p>}
        {Boolean(detail?.unavailable)&&<p className="batch-message">有 {detail?.unavailable} 个视频暂不可用，已保留其余内容。</p>}
      </>}/>
    {openedVideo && (() => {
      const video = nested.data
      const parts = video?.parts.map(part => toTrack(video, part)) ?? []
      const close = () => setOpenedVideo(undefined)
      const queue = parts.length ? seasonPlaybackQueue(playbackTracks, parts[0], parts) : playbackTracks
      if (isMobile && video && parts.length > 1) return <MobilePartsContent detail={video} onBack={close} playbackTracks={queue} queueSource={queueSource} showSeasonLink={false}/>
      return <CollectionDialog title={openedVideo.title} onClose={close}>
        {nested.isError ? <button className="load-more" onClick={() => void nested.refetch()}>{commandErrorMessage(nested.error)} · 重试</button> :
          !video ? <p className="batch-message">正在读取选集…</p> :
          parts.length > 1 ? <VideoPartsList locateCurrent tracks={parts} playbackTracks={queue} queueSource={queueSource}/> : <p className="batch-message">这个视频可以直接播放。</p>}
      </CollectionDialog>
    })()}
    {seasonOpen&&season&&<MobilePage title="B 站合集" onBack={()=>setSeasonOpen(false)}><StandardCollectionDetail embedded item={seasonCollection(season)} onBack={()=>setSeasonOpen(false)}/></MobilePage>}
  </section>
}

export function CollectionDetail(props: Parameters<typeof StandardCollectionDetail>[0]) {
  return props.item.bvid.startsWith('up:') ? <CreatorPage item={props.item} onOpen={props.onOpenCollection} searchQuery={props.searchQuery}/> : <StandardCollectionDetail {...props}/>
}
