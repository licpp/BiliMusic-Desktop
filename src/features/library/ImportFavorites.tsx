import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { ArrowLeft, ArrowRight, Check, ChevronRight, FileText, FolderHeart, Link2, ListPlus, LoaderCircle, Minus, Music2, Pause, Play, RefreshCw, Search, Square, X } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { toTrack } from '../../services/collectionTrack'
import { commandErrorMessage, getAccountProfile, getFavoriteFolders, getFavoriteVideos, getVideoParts, listPlaylistTracks, type Playlist } from '../../services/desktopApi'
import { reloadLinkedFolder } from '../../services/linkedFolders'
import { parseSongList, type ImportChoice, type ImportPlaylist } from '../../services/playlistImportModel'
import { acceptImportCandidate, bootPlaylistImport, clearPlaylistImport, commitImportTracks, findImportCandidates, makePlaylistReview, newPlaylistImport, pausePlaylistImport, replaceImportedPlaylistEntry, runPlaylistImport, usePlaylistImport, type ImportJob } from '../../services/playlistImport'
import { Artwork } from '../../shared/Artwork'
import { formatDuration } from '../../shared/time'
import { usePlayerStore } from '../player/playerStore'

type Source = 'bili'|'netease'|'qq'|'text'
const sources: {id:Source;title:string;description:string;mark:string}[] = [
  {id:'bili',title:'B 站收藏夹',description:'关联收藏夹，也可复制为歌单',mark:'B'},
  {id:'netease',title:'网易云音乐',description:'粘贴歌单分享链接',mark:'网'},
  {id:'qq',title:'QQ 音乐',description:'粘贴歌单分享链接',mark:'Q'},
  {id:'text',title:'歌曲列表',description:'每行一首，批量匹配',mark:'文'},
]

export function ImportPlaylistButton({onClick,sidebar=false}:{onClick:()=>void;sidebar?:boolean}) {
  const state=usePlaylistImport(value=>value.job?.state)
  const running=state==='matching'||state==='waiting'||state==='saving'
  return <button type="button" className={`playlist-import-trigger${sidebar?' sidebar-import-trigger':''}`} aria-label="导入歌单" title="导入歌单" onClick={onClick}>
    {running?<LoaderCircle size={16} className="spin"/>:<ListPlus size={17}/>}<span>{running?'导入中':'导入'}</span>
  </button>
}

export function ImportFavorites({onClose,onImported,reviewPlaylist}:{onClose:()=>void;onImported:(id:string,mode:'copy'|'link')=>void;reviewPlaylist?:Playlist}) {
  const client=useQueryClient(), backgroundJob=usePlaylistImport(value=>value.job), scope=usePlaylistImport(value=>value.scope)
  const [reviewJob,setReviewJob]=useState<ImportJob|null>(null)
  const job=reviewPlaylist?reviewJob:backgroundJob
  const [page,setPage]=useState<Source|'sources'|'progress'>(reviewPlaylist?'progress':'sources')
  const [mode,setMode]=useState<'copy'|'link'>('link'),[folderId,setFolderId]=useState<number>()
  const [input,setInput]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[biliStatus,setBiliStatus]=useState(''),[partialId,setPartialId]=useState('')
  const [filter,setFilter]=useState<'all'|'missing'>('all'),[visible,setVisible]=useState(40),[expanded,setExpanded]=useState<number>(),[keyword,setKeyword]=useState(''),[manualBusy,setManualBusy]=useState(false),[manualChoices,setManualChoices]=useState<ImportChoice[]>([])
  const [resultQuery,setResultQuery]=useState('')
  const cancelled=useRef(false),manualAbort=useRef<AbortController|undefined>(undefined),dialog=useRef<HTMLDivElement>(null)
  const account=useQuery({queryKey:['account'],queryFn:getAccountProfile,enabled:page==='bili'})
  const folders=useQuery({queryKey:['bili-favorites',account.data?.userId],queryFn:getFavoriteFolders,enabled:page==='bili'&&Boolean(account.data?.loggedIn)})
  const running=Boolean(job&&['matching','waiting','saving'].includes(job.state))
  const refresh=()=>Promise.all(['playlists','library'].map(key=>client.invalidateQueries({queryKey:[key]})))
  useEffect(()=>{
    cancelled.current=false
    if(!scope)void bootPlaylistImport().catch(cause=>{if(!cancelled.current)setError(commandErrorMessage(cause))})
    return ()=>{cancelled.current=true;manualAbort.current?.abort()}
  },[scope])
  useEffect(()=>{
    if(!reviewPlaylist||!scope)return
    let disposed=false
    const epoch=accountEpoch()
    setBusy(true)
    void listPlaylistTracks(reviewPlaylist.id).then(tracks=>{if(!disposed&&epoch===accountEpoch())setReviewJob(makePlaylistReview(reviewPlaylist,tracks,scope))})
      .catch(cause=>{if(!disposed)setError(commandErrorMessage(cause))}).finally(()=>{if(!disposed)setBusy(false)})
    return ()=>{disposed=true}
  },[reviewPlaylist?.id,scope])
  useEffect(()=>{if(job)setPage('progress')},[job?.id])
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();return ()=>previous?.focus()},[])
  useEffect(()=>{window.addEventListener('bilimusic-account-changing',onClose);return ()=>window.removeEventListener('bilimusic-account-changing',onClose)},[onClose])
  const dismiss=()=>{cancelled.current=true;manualAbort.current?.abort();onClose()}
  const endImport=()=>{clearPlaylistImport();void refresh();dismiss()}
  const startExternal=async()=>{
    setError('');setBusy(true)
    const epoch=accountEpoch()
    try {
      const playlist=page==='text'?parseSongList(input):await invoke<ImportPlaylist>('external_playlist_read',{input})
      if(cancelled.current||epoch!==accountEpoch())return
      if(!playlist.songs.length)throw new Error('这份歌单没有可导入的歌曲')
      await bootPlaylistImport()
      if(cancelled.current||epoch!==accountEpoch())return
      newPlaylistImport(playlist,name||playlist.name);setPage('progress')
      if(playlist.unavailableCount)setError(`${playlist.unavailableCount} 首来源歌曲暂不可读取，已继续处理其他歌曲`)
      void runPlaylistImport().then(()=>refresh())
    }catch(cause){if(!cancelled.current)setError(commandErrorMessage(cause))}
    finally{if(!cancelled.current)setBusy(false)}
  }
  const importBili=async()=>{
    const folder=folders.data?.find(item=>item.id===folderId)
    if(!folder||!scope)return
    setBusy(true);setError('');setPartialId('')
    const epoch=accountEpoch(),id=`import:${crypto.randomUUID()}`
    let count=0,failed=0
    const stopped=()=>cancelled.current||epoch!==accountEpoch()
    try {
      if(mode==='link') {
        setBiliStatus('正在关联收藏夹…');await reloadLinkedFolder(client,folder.id,true)
        if(!stopped())onImported(`bili-folder:${folder.id}`,'link')
        return
      }
      for(let page=1;!stopped();page++) {
        const result=await getFavoriteVideos(folder.id,page)
        for(const video of result.medias||[]) {
          if(stopped())break
          setBiliStatus(`正在导入「${video.title}」 · 已保存 ${count} 首`)
          try {
            const detail=await getVideoParts(video.bvid)
            if(stopped())break
            for(let offset=0;offset<detail.parts.length;offset+=100) {
              if(stopped())break
              const entries=detail.parts.slice(offset,offset+100).map(part=>({track:toTrack(detail,part)}))
              const saved=await commitImportTracks(scope,id,folder.title.slice(0,80),entries)
              count=saved.trackCount;if(!stopped())setPartialId(id)
            }
          }catch(cause){if(stopped())break;failed++;setError(`${failed} 个视频暂未导入：${commandErrorMessage(cause)}`)}
        }
        if(!result.has_more||!result.medias?.length)break
      }
      if(!stopped())setBiliStatus(`已导入 ${count} 首${failed?`，${failed} 个视频暂不可用`:''}`)
    }catch(cause){if(!stopped())setError(commandErrorMessage(cause))}
    finally{if(!stopped())setBusy(false);await refresh()}
  }
  const searchRow=async(index:number,term:string)=>{
    if(!job||!term.trim())return
    const abort=new AbortController();manualAbort.current?.abort();manualAbort.current=abort
    const epoch=accountEpoch();setManualBusy(true);setError('')
    try {const choices=await findImportCandidates(job.rows[index].song,abort.signal,term.trim());if(!abort.signal.aborted&&epoch===accountEpoch())setManualChoices(choices)}
    catch(cause){if(!abort.signal.aborted)setError(commandErrorMessage(cause))}
    finally{if(!abort.signal.aborted)setManualBusy(false)}
  }
  const manualSearch=()=>expanded===undefined?undefined:searchRow(expanded,keyword)
  const expandRow=(index:number)=>{
    manualAbort.current?.abort();setManualChoices([]);setManualBusy(false)
    if(expanded===index){setExpanded(undefined);return}
    const row=job!.rows[index],term=`${row.song.title} ${row.song.artists[0]||''}`.trim()
    setExpanded(index);setKeyword(term);void searchRow(index,term)
  }
  const choose=async(choice:ImportChoice)=>{
    if(expanded===undefined)return
    setError('');setManualBusy(true)
    const epoch=accountEpoch()
    try{
      if(reviewPlaylist&&reviewJob){
        await replaceImportedPlaylistEntry(reviewPlaylist,reviewJob.rows[expanded].chosen!.track,choice,scope)
        if(cancelled.current||epoch!==accountEpoch())return
        const tracks=await listPlaylistTracks(reviewPlaylist.id)
        if(cancelled.current||epoch!==accountEpoch())return
        setReviewJob(makePlaylistReview(reviewPlaylist,tracks,scope))
      }else await acceptImportCandidate(expanded,choice)
      setExpanded(undefined);setManualChoices([]);await refresh()
    }
    catch(cause){setError(commandErrorMessage(cause))}
    finally{setManualBusy(false)}
  }
  const title=reviewPlaylist?'重新匹配视频':page==='sources'?'导入歌单':page==='progress'?'导入进度':sources.find(source=>source.id===page)?.title||'导入歌单'
  const saved=new Set(job?.rows.filter(row=>row.status==='saved').map(row=>row.chosen?.track.id)).size,missing=job?.rows.filter(row=>row.status==='missing').length||0,processed=job?.rows.filter(row=>row.status!=='pending').length||0
  const results=job?.rows.map((row,index)=>({row,index})).filter(({row})=>`${row.song.title} ${row.song.artists.join(' ')}`.toLocaleLowerCase().includes(resultQuery.toLocaleLowerCase())&&(reviewPlaylist||filter==='all'||row.status==='missing'))||[]
  return <div className={`playlist-import-backdrop${page==='sources'?' source-picker':''}`} onClick={event=>{if(event.target===event.currentTarget)dismiss()}}>
    <div ref={dialog} className="playlist-import-dialog" role="dialog" aria-modal="true" aria-label={reviewPlaylist?'重新匹配视频':'导入歌单'} tabIndex={-1} onKeyDown={event=>{
      if(event.key==='Escape'){event.stopPropagation();dismiss()}
      if(event.key==='Tab') {const items=[...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,[tabindex="0"]')].filter(el=>el.getClientRects().length);const first=items[0],last=items.at(-1);if(document.activeElement===dialog.current){event.preventDefault();(event.shiftKey?last:first)?.focus()}else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}
    }}>
      <header className="import-header"><div>{page!=='sources'&&page!=='progress'&&<button className="import-icon" disabled={busy} aria-label="返回导入来源" onClick={()=>{setPage('sources');setError('');setBiliStatus('')}}><ArrowLeft size={20}/></button>}<h2>{title}</h2></div><button className="import-icon" aria-label={reviewPlaylist?'关闭重新匹配':running?'收起导入进度':'关闭导入'} title={running?'收起后继续导入':undefined} onClick={dismiss}>{running?<Minus size={20}/>:<X size={20}/>}</button></header>
      <div className="import-body">
        {page==='sources'&&<><div className="import-sources">{sources.map(source=><button key={source.id} type="button" onClick={()=>{setPage(source.id);setInput('');setName('');setError('')}}><span className={`import-source-mark source-${source.id}`}>{source.id==='text'?<FileText size={21}/>:source.mark}</span><span><strong>{source.title}</strong><small>{source.description}</small></span><ChevronRight size={18}/></button>)}</div><p className="import-hint">网易云、QQ 音乐和文本列表会自动匹配 B 站资源。</p></>}
        {(page==='netease'||page==='qq'||page==='text')&&<form id="external-playlist-form" onSubmit={event=>{event.preventDefault();void startExternal()}} className="import-source-form">
          <div className="import-form-heading"><span className={`import-source-mark source-${page}`}>{page==='text'?<FileText size={20}/>:page==='qq'?'Q':'网'}</span><div><strong>{page==='text'?'粘贴歌曲列表':'粘贴歌单分享链接'}</strong><p>{page==='text'?'每行一首，例如：传奇 - 王菲':'支持完整分享文字和短链接，无需登录音乐平台。'}</p></div></div>
          <label htmlFor="playlist-import-input" className="sr-only">{page==='text'?'歌曲列表':'歌单链接'}</label><textarea id="playlist-import-input" autoFocus required disabled={busy} value={input} onChange={event=>setInput(event.target.value)} placeholder={page==='text'?'传奇 - 王菲\n因为爱情 - 陈奕迅 / 王菲':'在这里粘贴歌单链接或分享文字…'} rows={page==='text'?7:4} maxLength={page==='text'?1_000_000:16_000}/>
          <label className="import-name-field">歌单名称 <span>选填</span><input maxLength={80} value={name} disabled={busy} onChange={event=>setName(event.target.value)} placeholder="默认沿用原歌单名称"/></label><div className="import-note"><Music2 size={18}/><p>自动匹配并保存，未找到的歌曲会跳过。导入后仍可更换版本。</p></div>
        </form>}
        {page==='bili'&&<>
          <div className="bili-copy-setting"><div><strong id="bili-copy-label">复制为本地歌单</strong><small>{mode==='copy'?'复制到“歌单”，之后独立管理。':'保存到“歌单”，与 B 站保持同步。'}</small></div><button className="bili-copy-switch" type="button" role="switch" aria-labelledby="bili-copy-label" aria-checked={mode==='copy'} disabled={busy} onClick={()=>setMode(mode==='copy'?'link':'copy')}><span/></button></div>
          <div className="import-section-label">选择收藏夹</div>
          {!account.data?.loggedIn?<div className="import-empty"><FolderHeart size={28}/><p>请先登录 B 站账号，再选择收藏夹。</p></div>:folders.isLoading?<p className="import-inline-status"><LoaderCircle className="spin" size={17}/>正在读取收藏夹…</p>:folders.isError?<button className="import-secondary" onClick={()=>void folders.refetch()}>读取失败，重试</button>:<div className="import-folders">{folders.data?.map(folder=><button disabled={busy} key={folder.id} aria-pressed={folder.id===folderId} onClick={()=>setFolderId(folder.id)}><span className="import-folder-icon"><FolderHeart size={21}/></span><span><strong>{folder.title}</strong><small>{folder.media_count} 个视频</small></span><span className="import-selection">{folder.id===folderId&&<Check size={15}/>}</span></button>)}{folders.data?.length===0&&<p className="import-hint">还没有可导入的收藏夹。</p>}</div>}
          {biliStatus&&<p className="import-inline-status">{busy&&<LoaderCircle className="spin" size={16}/>} {biliStatus}</p>}
        </>}
        {page==='progress'&&job&&<>
          <div className="import-progress-card"><div className="import-progress-heading"><span className={`import-source-mark source-${job.source}`}>{reviewPlaylist?<RefreshCw size={21}/>:<ListPlus size={21}/>}</span><div><h3>{job.name}</h3><p>{reviewPlaylist?`共 ${job.rows.length} 首 · 选择歌曲后重新搜索`:`共 ${job.rows.length} 首 · 已保存 ${saved} 首${missing?` · 未匹配 ${missing} 首`:''}`}</p></div>{!reviewPlaylist&&(running?<LoaderCircle size={20} className="spin"/>:job.state==='done'?<Check size={22}/>:<Pause size={20}/>)}</div>{reviewPlaylist?<p className="import-review-note">只替换当前歌单中的视频，歌名、封面和其他收藏保留。</p>:<><progress max={job.rows.length} value={processed}/><p role="status">{job.message}</p>{job.state!=='done'&&<small>收起后可继续导入；结束导入会保留已经保存的歌曲。</small>}</>}</div>
          <div className="import-result-tools">{!reviewPlaylist&&<div role="group" aria-label="筛选导入结果"><button aria-pressed={filter==='all'} onClick={()=>{setFilter('all');setVisible(40)}}>全部</button><button aria-pressed={filter==='missing'} onClick={()=>{setFilter('missing');setVisible(40)}}>未匹配{missing?` ${missing}`:''}</button></div>}<label className="import-review-search"><span className="import-search-icon"><Search size={16}/></span><input aria-label="搜索歌单中的歌曲" placeholder="搜索歌单中的歌曲" value={resultQuery} onChange={event=>{setResultQuery(event.target.value);setVisible(40)}}/>{resultQuery&&<button type="button" className="import-search-clear" aria-label="清空歌单搜索" onClick={()=>{setResultQuery('');setVisible(40)}}><X size={14}/></button>}</label></div>
          <div className="import-results">{results.slice(0,visible).map(({row,index})=><div className="import-result" key={row.song.sourceId}>
            <div className="import-result-line"><span className="import-result-index">{index+1}</span><Artwork src={row.song.coverUrl||row.chosen?.track.coverUrl} fallback={<Music2 size={18}/>} className="import-result-art"/><div className="import-result-copy"><strong>{row.song.title}</strong><small>{row.song.artists.join(' / ')||'歌手未知'}{row.song.durationSeconds?` · ${formatDuration(row.song.durationSeconds)}`:''}</small></div>{!reviewPlaylist&&<span className={`import-result-status status-${row.status}`}>{row.status==='saved'?'已导入':row.status==='matched'?'已匹配':row.status==='missing'?'未匹配':'等待'}</span>}<button className="import-edit-choice" disabled={running||(manualBusy&&expanded!==index)} onClick={()=>expandRow(index)}><RefreshCw size={13}/><span>{expanded===index?'收起':row.status==='missing'?'查找':'更换'}</span></button></div>
            {expanded===index&&<div className="import-candidate-panel"><form onSubmit={event=>{event.preventDefault();void manualSearch()}}><Search size={16}/><input aria-label="搜索其他歌曲版本" value={keyword} onChange={event=>setKeyword(event.target.value)}/><button disabled={manualBusy||!keyword.trim()} type="submit">{manualBusy?<LoaderCircle size={16} className="spin"/>:'搜索'}</button></form>{manualChoices.map(choice=><div className="import-candidate" key={choice.track.id}><button className="import-preview" aria-label={`试听 ${choice.track.title}`} onClick={()=>void usePlayerStore.getState().play(choice.track)}><Play size={15}/></button><div><strong>{choice.track.title}</strong><small>{choice.track.source.uploaderName} · {formatDuration(choice.track.durationSeconds)}</small></div><button className="import-use" disabled={manualBusy||row.chosen?.track.id===choice.track.id} onClick={()=>void choose(choice)}>{row.chosen?.track.id===choice.track.id?<><Check size={14}/><span>已选</span></>:<><Check size={14}/><span>使用</span></>}</button></div>)}{!manualBusy&&!manualChoices.length&&<p className="import-hint">换个关键词，查找其他版本。</p>}</div>}
          </div>)}{results.length>visible&&<button className="import-show-more" onClick={()=>setVisible(value=>value+40)}>显示更多歌曲</button>}{!results.length&&<p className="import-hint">{filter==='missing'?'暂时没有未匹配的歌曲。':'等待导入结果。'}</p>}</div>
        </>}
        {reviewPlaylist&&busy&&<p className="import-inline-status"><LoaderCircle size={16} className="spin"/>正在读取歌单…</p>}
        {error&&<p className="import-error" role="alert">{error}</p>}
      </div>
      {page!=='sources'&&<footer className="import-footer">
        {reviewPlaylist?<button className="import-primary" onClick={dismiss}>完成</button>:page==='progress'&&job?<>
          {running?<button className="import-secondary" onClick={pausePlaylistImport}><Pause size={16}/>暂停</button>:job.state==='done'?<button className="import-secondary" onClick={()=>{clearPlaylistImport();setPage('sources');setError('')}}>导入其他歌单</button>:<button className="import-primary" onClick={()=>void runPlaylistImport().then(()=>refresh())}><Play size={16}/>继续导入</button>}
          {job.state==='done'&&missing>0&&<button className="import-secondary" onClick={()=>void runPlaylistImport(true).then(()=>refresh())}><RefreshCw size={15}/>重试未匹配</button>}
          {job.state!=='done'&&<button className="import-secondary" onClick={endImport} title="保留已保存的歌曲，停止后续导入"><Square size={14}/>结束导入</button>}
          {saved>0&&<button className={job.state==='done'?'import-primary':'import-secondary'} onClick={()=>{void refresh();onImported(job.playlistId,'copy')}}>打开歌单<ArrowRight size={16}/></button>}
        </>:page==='bili'?<><small>导入到我的歌单</small>{busy&&mode==='copy'&&<button className="import-secondary" onClick={dismiss}><Square size={14}/>结束导入</button>}{partialId&&!busy?<button className="import-primary" onClick={()=>onImported(partialId,'copy')}>打开歌单<ArrowRight size={16}/></button>:<button className="import-primary" disabled={busy||!folderId||!scope} onClick={()=>void importBili()}>{busy?<LoaderCircle size={17} className="spin"/>:mode==='copy'?<ListPlus size={17}/>:<Link2 size={17}/>} {busy?'正在处理…':mode==='copy'?'导入歌单':'关联收藏夹'}</button>}</>:<><small>自动匹配，无需逐首确认</small><button className="import-primary" type="submit" form="external-playlist-form" disabled={busy||!input.trim()||!scope}>{busy?<LoaderCircle size={17} className="spin"/>:<ListPlus size={18}/>} {busy?'读取歌单中…':'开始导入'}</button></>}
      </footer>}
    </div>
  </div>
}
