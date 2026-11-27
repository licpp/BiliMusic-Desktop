import { useOverlayDismiss } from '../../shared/useOverlayDismiss'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { ArrowLeft, ArrowRight, Check, ChevronRight, FileText, FolderHeart, FolderOpen, Layers, Link2, ListPlus, LoaderCircle, Minus, Music2, Pause, Play, RefreshCw, Search, Square, X, type LucideIcon } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage, inDesktopShell } from '../../services/desktopApi'
import { isMobile } from '../../services/platform'
import type { Playlist } from '../../domain/library'
import { parseSongList, playlistLinkPlatform, type ImportPlaylist } from '../../services/playlistImportModel'
import { bootPlaylistImport, clearPlaylistImport, newPlaylistImport, pausePlaylistImport, runPlaylistImport, usePlaylistImport } from '../../services/playlistImport'
import { Artwork } from '../../shared/Artwork'
import { formatDuration } from '../../shared/time'
import { ImportedPlaylistCompletion } from './ImportedPlaylistCompletion'
import { ReplacementDialog } from './ReplacementDialog'
import { FavoriteFolderImport } from './FavoriteFolderImport'
import { SubscribedSeasonImport } from './SubscribedSeasonImport'
import type { ImportedEntry, ImportedEntriesSnapshot } from '../../domain/importedEntry'

type Source = 'bili'|'seasons'|'online'|'text'|'local'
const sources: {id:Source;title:string;description:string;Icon:LucideIcon}[] = [
  {id:'bili',title:'B 站收藏夹',description:'关联收藏夹，也可复制为歌单',Icon:FolderHeart},
  {id:'online',title:'在线歌单',description:'网易云、QQ、酷狗、酷我、咪咕',Icon:Link2},
  {id:'seasons',title:'B 站已订阅合集',description:'导入到收藏',Icon:Layers},
  {id:'text',title:'歌曲列表',description:'每行一首，批量匹配',Icon:FileText},
  ...(inDesktopShell&&!isMobile ? [{id:'local' as const,title:'本地音乐文件夹',description:'读取歌曲信息，匹配 B 站音源',Icon:FolderOpen}] : []),
]

export function ImportPlaylistButton({onClick,sidebar=false,disabled}:{onClick:()=>void;sidebar?:boolean;disabled?:boolean}) {
  const state=usePlaylistImport(value=>value.job?.state)
  const running=state==='matching'||state==='waiting'||state==='saving'
  return <button type="button" className={`playlist-import-trigger library-import-action${sidebar?' sidebar-import-trigger':''}`} aria-label="导入歌单" title="导入歌单" disabled={disabled} onClick={onClick}>
    {running?<LoaderCircle size={16} className="spin"/>:<ListPlus size={17}/>}<span>{running?'导入中':'导入'}</span>
  </button>
}

type ImportFavoritesProps = {onClose:()=>void;onImported:(id:string,mode:'copy'|'link')=>void;onViewCollections:()=>void;reviewPlaylist?:Playlist}
export function ImportFavorites(props:ImportFavoritesProps) {
  return props.reviewPlaylist ? <ImportedPlaylistCompletion playlist={props.reviewPlaylist} onClose={props.onClose}/> : <ImportFavoritesFlow {...props}/>
}

function ImportFavoritesFlow({onClose,onImported,onViewCollections}:Omit<ImportFavoritesProps,'reviewPlaylist'>) {
  const client=useQueryClient(), backgroundJob=usePlaylistImport(value=>value.job), scope=usePlaylistImport(value=>value.scope)
  const job=backgroundJob
  const [page,setPage]=useState<Source|'sources'|'progress'>('sources')
  const [input,setInput]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [filter,setFilter]=useState<'all'|'missing'>('all'),[visible,setVisible]=useState(40),[replacement,setReplacement]=useState<ImportedEntry>()
  const [resultQuery,setResultQuery]=useState('')
  const [localPlaylist,setLocalPlaylist]=useState<ImportPlaylist>()
  const cancelled=useRef(false),dialog=useRef<HTMLDivElement>(null)
  const running=Boolean(job&&['matching','waiting','saving'].includes(job.state))
  const refresh=()=>Promise.all(['playlists','library'].map(key=>client.invalidateQueries({queryKey:[key]})))
  useEffect(()=>{
    cancelled.current=false
    if(!scope)void bootPlaylistImport().catch(cause=>{if(!cancelled.current)setError(commandErrorMessage(cause))})
    return ()=>{cancelled.current=true}
  },[scope])
  useEffect(()=>{if(job)setPage('progress')},[job?.id])
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();return ()=>previous?.focus()},[])
  useEffect(()=>{if(page==='seasons'||page==='sources'||page==='local')dialog.current?.focus()},[page])
  useEffect(()=>{window.addEventListener('bilimusic-account-changing',onClose);return ()=>window.removeEventListener('bilimusic-account-changing',onClose)},[onClose])
  const dismiss=()=>{if((page==='seasons'||page==='local')&&busy)return;cancelled.current=true;onClose()}
  const back = () => {
    if (page === 'sources' || page === 'progress') dismiss()
    else if (!busy) { setPage('sources'); setError('') }
  }
  useOverlayDismiss(dialog, true, back)
  const endImport=()=>{clearPlaylistImport();void refresh();dismiss()}
  const openLocal = async () => {
    if (busy) return
    const epoch = accountEpoch()
    const current = () => !cancelled.current && epoch === accountEpoch()
    setError('')
    setBusy(true)
    try {
      const playlist = await invoke<ImportPlaylist | null>('local_playlist_pick')
      if (!current() || !playlist) return
      setLocalPlaylist(playlist)
      setName('')
    } catch (cause) {
      if (current()) setError(commandErrorMessage(cause))
    } finally {
      if (current()) setBusy(false)
    }
  }
  const startExternal=async()=>{
    setError('');setBusy(true)
    const epoch=accountEpoch()
    try {
      const playlist=page==='local'?localPlaylist:page==='text'?parseSongList(input):await invoke<ImportPlaylist>('external_playlist_read',{input})
      if(cancelled.current||epoch!==accountEpoch())return
      if(!playlist)return
      if(!playlist.songs.length)throw new Error('这份歌单没有可导入的歌曲')
      await bootPlaylistImport()
      if(cancelled.current||epoch!==accountEpoch())return
      newPlaylistImport(playlist,name||playlist.name);setPage('progress')
      if(playlist.unavailableCount)setError(`${playlist.unavailableCount} 首来源歌曲暂不可读取，已继续处理其他歌曲`)
      void runPlaylistImport().then(()=>refresh())
    }catch(cause){if(!cancelled.current)setError(commandErrorMessage(cause))}
    finally{if(!cancelled.current)setBusy(false)}
  }
  const replacementSaved=(snapshot:ImportedEntriesSnapshot)=>{
    const current=usePlaylistImport.getState().job
    if(current&&job&&current.playlistId===job.playlistId){
      const entries=new Map(snapshot.entries.map(entry=>[entry.entryId,entry]))
      usePlaylistImport.setState({job:{...current,session:snapshot.session,rows:current.rows.map(row=>{
        const entry=row.entry&&entries.get(row.entry.entryId)
        if(!entry)return row
        return {...row,entry,status:entry.trackId?'saved':'missing',chosen:row.chosen?.track.id===entry.trackId?row.chosen:undefined,candidates:[]}
      })}})
    }
    setReplacement(undefined);void refresh()
  }
  const title=page==='sources'?'导入歌单':page==='progress'?'导入进度':sources.find(source=>source.id===page)?.title||'导入歌单'
  const saved=new Set(job?.rows.filter(row=>row.status==='saved').map(row=>row.entry?.trackId||row.chosen?.track.id).filter(Boolean)).size,missing=job?.rows.filter(row=>row.status==='missing').length||0,processed=job?.rows.filter(row=>row.status!=='pending').length||0
  const results=job?.rows.map((row,index)=>({row,index})).filter(({row})=>`${row.song.title} ${row.song.artists.join(' ')}`.toLocaleLowerCase().includes(resultQuery.toLocaleLowerCase())&&(filter==='all'||row.status==='missing'))||[]
  return <div className={`playlist-import-backdrop${page==='sources'?' source-picker':''}`} onClick={event=>{if(event.target===event.currentTarget)dismiss()}}>
    <div ref={dialog} className="playlist-import-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={event=>{
      if(event.key==='Escape'){event.stopPropagation();back()}
      if(event.key==='Tab') {const items=[...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,[tabindex="0"]')].filter(el=>el.getClientRects().length);const first=items[0],last=items.at(-1);if(document.activeElement===dialog.current){event.preventDefault();(event.shiftKey?last:first)?.focus()}else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}
    }}>
      <header className="import-header"><div>{page!=='sources'&&page!=='progress'&&<button className="import-icon" disabled={busy} aria-label="返回导入来源" onClick={back}><ArrowLeft size={20}/></button>}<h2>{title}</h2></div><button className="import-icon" disabled={(page==='seasons'||page==='local')&&busy} aria-label={running?'收起导入进度':'关闭导入'} title={running?'收起后继续导入':undefined} onClick={dismiss}>{running?<Minus size={20}/>:<X size={20}/>}</button></header>
      <div className="favorite-import-slot" hidden={page!=='bili'}><FavoriteFolderImport active={page==='bili'} busy={busy} onBusyChange={setBusy} onStop={dismiss} onImported={onImported}/></div>
      {page==='seasons'?<SubscribedSeasonImport busy={busy} onBusyChange={setBusy} onViewCollections={onViewCollections}/>:page!=='bili'&&<>
      <div className="import-body">
        {page==='sources' && <div className="import-sources">{sources.map(source => (
          <button key={source.id} type="button" data-source={source.id} onClick={() => { setPage(source.id); setInput(''); setName(''); setError('') }}>
            <span className={`import-source-mark source-${source.id}`} aria-hidden="true">
              <source.Icon size={21}/>
            </span>
            <span className="import-source-copy"><strong>{source.title}</strong><small>{source.description}</small></span>
            <ChevronRight size={18} aria-hidden="true"/>
          </button>
        ))}</div>}
        {(page==='online'||page==='text')&&<form id="external-playlist-form" onSubmit={event=>{event.preventDefault();void startExternal()}} className="import-source-form">
          <div className="import-form-heading"><span className={`import-source-mark source-${page}`}>{page==='text'?<FileText size={20}/>:<Link2 size={20}/>}</span><div><strong>{page==='text'?'粘贴歌曲列表':'粘贴歌单分享链接'}</strong><p>{page==='text'?'每行一首，例如：传奇 - 王菲':'支持完整分享文字和短链接，无需登录音乐平台。'}</p></div></div>
          <label htmlFor="playlist-import-input" className="sr-only">{page==='text'?'歌曲列表':'歌单链接'}</label><textarea id="playlist-import-input" autoFocus required disabled={busy} value={input} onChange={event=>setInput(event.target.value)} placeholder={page==='text'?'传奇 - 王菲\n因为爱情 - 陈奕迅 / 王菲':'支持网易云、QQ 音乐、酷狗、酷我、咪咕，粘贴歌单链接或分享文字…'} rows={page==='text'?7:4} maxLength={page==='text'?1_000_000:16_000}/>
          {page==='online'&&playlistLinkPlatform(input)&&<p className="import-detected-source"><Check size={14}/>已识别：{playlistLinkPlatform(input)}</p>}
          <label className="import-name-field">歌单名称 <span>选填</span><input maxLength={80} value={name} disabled={busy} onChange={event=>setName(event.target.value)} placeholder={page==='text'?'为这份歌单命名':'默认沿用原歌单名称'}/></label>
        </form>}
        {page==='local'&&<form id="external-playlist-form" className="import-source-form" onSubmit={event=>{event.preventDefault();if(!busy&&localPlaylist)void startExternal()}}>
          <div className="import-local-folder">
            <span className="import-source-mark"><FolderOpen size={21}/></span>
            <div><strong>{localPlaylist?.name || '选择音乐文件夹'}</strong>
              <small role="status">{busy?'正在读取歌曲信息…':localPlaylist?`识别到 ${localPlaylist.songs.length} 首`:'含子文件夹'}</small>
            </div>
            <button type="button" className="import-secondary" disabled={busy} onClick={()=>void openLocal()}>{localPlaylist?'更换':'选择文件夹'}</button>
          </div>
          {localPlaylist&&<label className="import-name-field">歌单名称 <span>选填</span><input maxLength={80} value={name} disabled={busy} onChange={event=>setName(event.target.value)} placeholder={localPlaylist.name}/></label>}
        </form>}
        {page==='progress'&&job&&<>
          <div className="import-progress-card"><div className="import-progress-heading"><span className={`import-source-mark source-${job.source}`}><ListPlus size={21}/></span><div><h3>{job.name}</h3><p>{`共 ${job.rows.length} 首 · 已保存 ${saved} 首${missing?` · 未匹配 ${missing} 首`:''}`}</p></div>{running?<LoaderCircle size={20} className="spin"/>:job.state==='done'?<Check size={22}/>:<Pause size={20}/>}</div><progress max={job.rows.length} value={processed}/><p role="status">{job.message}</p>{job.state!=='done'&&<small>收起后可继续导入；结束导入会保留已经保存的歌曲。</small>}</div>
          <div className="import-result-tools">{<div role="group" aria-label="筛选导入结果"><button aria-pressed={filter==='all'} onClick={()=>{setFilter('all');setVisible(40)}}>全部</button><button aria-pressed={filter==='missing'} onClick={()=>{setFilter('missing');setVisible(40)}}>未匹配{missing?` ${missing}`:''}</button></div>}<label className="import-review-search"><span className="import-search-icon"><Search size={16}/></span><input aria-label="搜索歌单中的歌曲" placeholder="搜索歌单中的歌曲" value={resultQuery} onChange={event=>{setResultQuery(event.target.value);setVisible(40)}}/>{resultQuery&&<button type="button" className="import-search-clear" aria-label="清空歌单搜索" onClick={()=>{setResultQuery('');setVisible(40)}}><X size={14}/></button>}</label></div>
          <div className="import-results">{results.slice(0,visible).map(({row,index})=><div className="import-result" key={row.song.sourceId}>
            <div className="import-result-line"><span className="import-result-index">{index+1}</span><Artwork src={row.song.coverUrl||row.chosen?.track.coverUrl} fallback={<Music2 size={18}/>} className="import-result-art"/><div className="import-result-copy"><strong>{row.song.title}</strong><small>{row.song.artists.join(' / ')||'歌手未知'}{row.song.durationSeconds?` · ${formatDuration(row.song.durationSeconds)}`:''}</small></div>{<span className={`import-result-status status-${row.status}`}>{row.status==='saved'?'已导入':row.status==='matched'?'已匹配':row.status==='missing'?'未匹配':'等待'}</span>}<button className="import-edit-choice" disabled={running||!row.entry||!job.session} onClick={()=>setReplacement(row.entry)}><Search size={13}/><span>{row.status==='missing'?'查找':'更换'}</span></button></div>

          </div>)}{results.length>visible&&<button className="import-show-more" onClick={()=>setVisible(value=>value+40)}>显示更多歌曲</button>}{!results.length&&<p className="import-hint">{filter==='missing'?'暂时没有未匹配的歌曲。':'等待导入结果。'}</p>}</div>
        </>}
        {error&&<p className="import-error" role="alert">{error}</p>}
      </div>
      {page!=='sources'&&<footer className="import-footer">
        {page==='progress'&&job?<>
          {running?<button className="import-secondary" onClick={pausePlaylistImport}><Pause size={16}/>暂停</button>:job.state==='done'?<button className="import-secondary" onClick={()=>{clearPlaylistImport();setPage('sources');setError('')}}>导入其他歌单</button>:<button className="import-primary" onClick={()=>void runPlaylistImport().then(()=>refresh())}><Play size={16}/>继续导入</button>}
          {job.state==='done'&&missing>0&&<button className="import-secondary" onClick={()=>void runPlaylistImport(true).then(()=>refresh())}><RefreshCw size={15}/>重试未匹配</button>}
          {job.state!=='done'&&<button className="import-secondary" onClick={endImport} title="保留已保存的歌曲，停止后续导入"><Square size={14}/>结束导入</button>}
          {saved>0&&<button className={job.state==='done'?'import-primary':'import-secondary'} onClick={()=>{void refresh();onImported(job.playlistId,'copy')}}>打开歌单<ArrowRight size={16}/></button>}
        </>:<><span/><button className="import-primary" type="submit" form="external-playlist-form" disabled={busy||!scope||(page==='local'?!localPlaylist:!input.trim())}>{busy?<LoaderCircle size={17} className="spin"/>:<ListPlus size={18}/>} {page==='local'?'开始匹配':busy?'读取歌单中…':'开始导入'}</button></>}
      </footer>}
      </>}
    </div>
    {replacement&&job?.session&&<ReplacementDialog entry={replacement} session={job.session} onSaved={replacementSaved} onClose={()=>setReplacement(undefined)}/>}
  </div>
}
