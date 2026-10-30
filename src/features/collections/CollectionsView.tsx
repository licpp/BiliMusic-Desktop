import { invoke } from '@tauri-apps/api/core'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Bookmark, Check, ChevronDown, ChevronRight, Folder, FolderInput, ListPlus, Play, Plus, RefreshCw, Search, X } from 'lucide-react'
import { changeCollection, listCollections, type Collection } from '../../services/collections'
import { commandErrorMessage, getVideoParts } from '../../services/desktopApi'
import { Artwork } from '../../shared/Artwork'
import { ActionMenu } from '../../shared/ActionMenu'
import { useCompactLayout } from '../../shared/useCompactLayout'
import { toTrack } from '../../services/collectionTrack'
import { usePlayerStore } from '../player/playerStore'
import { TrackMenuButton } from '../library/TrackActions'
import { showTrackMenu } from '../library/trackActionStore'
import { formatDuration } from '../../shared/time'

const useCollections = () => useQuery({ queryKey: ['collections'], queryFn: listCollections })
type CollectionInfo = Omit<Collection, 'folderId'>

function CollectionDialog({ title, onClose, children }: {title:string;onClose:()=>void;children:ReactNode}) {
  const layer=useRef<HTMLDivElement>(null), dismiss=useRef(onClose)
  dismiss.current=onClose
  useEffect(()=>{
    const root=document.getElementById('root'),previous=document.activeElement as HTMLElement|null
    const wasInert=root?.inert || false
    if(root)root.inert=true
    const top=()=>[...document.querySelectorAll('.collection-dialog-layer')].at(-1)===layer.current
    const keyboard=(e:KeyboardEvent)=>{
      if(!top())return
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();dismiss.current()}
      if(e.key==='Tab'){
        const buttons=[...layer.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')]
        const index=buttons.indexOf(document.activeElement as HTMLElement)
        if((e.shiftKey&&index<=0)||(!e.shiftKey&&index===buttons.length-1)){e.preventDefault();buttons[e.shiftKey?buttons.length-1:0]?.focus()}
      }
    }
    const back=(e:Event)=>{if(top()){e.preventDefault();e.stopImmediatePropagation();dismiss.current()}}
    document.addEventListener('keydown',keyboard,true);window.addEventListener('bilimusic-back',back,true)
    layer.current?.querySelector<HTMLElement>('input,button')?.focus()
    return()=>{document.removeEventListener('keydown',keyboard,true);window.removeEventListener('bilimusic-back',back,true);if(root)root.inert=wasInert;if(previous?.isConnected&&!previous.closest('[inert]'))previous.focus()}
  },[])
  return createPortal(<div ref={layer} className="dialog-backdrop collection-dialog-layer" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section className="collection-dialog" role="dialog" aria-modal="true" aria-label={title}><header><h3>{title}</h3><button className="collection-icon" aria-label="关闭" onClick={onClose}><X size={19}/></button></header>{children}</section></div>,document.body)
}

export function CollectionBookmark({ item }: { item: CollectionInfo }) {
  const query=useCollections(),client=useQueryClient(),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const saved=query.data?.items.find(i=>i.bvid===item.bvid)
  const toggle=async()=>{
    setBusy(true);setError('')
    try{await changeCollection(saved?'remove':'save',item.bvid,'',{...item,folderId:''});await client.invalidateQueries({queryKey:['collections']})}
    catch(e){setError(commandErrorMessage(e))}finally{setBusy(false)}
  }
  return <><button className={`icon-action collection-bookmark ${saved?'saved':''}`} disabled={busy||query.isLoading} aria-label={saved?'取消收藏合集':'收藏整个合集'} aria-pressed={!!saved} title={saved?'取消收藏合集':'收藏整个合集'} onClick={()=>void toggle()}><Bookmark size={18} fill={saved?'currentColor':'none'}/></button>{error&&<span role="alert" className="inline-error">{error}</span>}</>
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
  </>}</ActionMenu>{error&&<p className="inline-error" role="alert">{error}</p>}{picking&&<CollectionDialog title="收藏到" onClose={()=>setPicking(false)}><p>{item.title||item.bvid}</p><div className="collection-folder-options">{[{id:'',name:'默认收藏夹'},...(q.data?.folders||[])].map(f=><button key={f.id} disabled={busy} onClick={()=>void change(saved?'move':'save',f.id)}><Folder size={17}/><span>{f.name}</span>{saved?.folderId===f.id&&<Check size={17}/>}</button>)}</div><FolderEditor action="create" onDone={()=>void client.invalidateQueries({queryKey:['collections']})}/>{error&&<p role="alert" className="inline-error">{error}</p>}</CollectionDialog>}</>
}

function FolderEditor({action,id='',initial='',onDone,controlledOpen,onClose}:{action:'create'|'rename'|'delete';id?:string;initial?:string;onDone:()=>void;controlledOpen?:boolean;onClose?:()=>void}){
  const [open,setOpen]=useState(false),[name,setName]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const visible=controlledOpen??open
  const close=()=>{setOpen(false);onClose?.()}
  const title=action==='create'?'新建收藏夹':action==='rename'?'重命名收藏夹':'删除收藏夹'
  return <>{controlledOpen===undefined&&<button className="collection-flat-button" aria-label={title} onClick={()=>{setName(initial);setError('');setOpen(true)}}>{action==='create'?<><Plus size={16}/><span>新建收藏夹</span></>:action==='rename'?'重命名':'删除收藏夹'}</button>}{visible&&<CollectionDialog title={title} onClose={close}><form onSubmit={async e=>{e.preventDefault();setBusy(true);try{await changeCollection(action,id,name);close();onDone()}catch(e){setError(commandErrorMessage(e))}finally{setBusy(false)}}}>{action==='delete'?<p>里面的合集会移回默认收藏夹，不会取消收藏。</p>:<input aria-label="收藏夹名称" value={name} maxLength={80} onChange={e=>setName(e.target.value)} placeholder="收藏夹名称"/>}{error&&<p role="alert" className="inline-error">{error}</p>}<footer><button type="button" className="collection-flat-button" onClick={close}>取消</button><button className="collection-primary" type="submit" disabled={busy||(action!=='delete'&&!name.trim())}>{busy?'处理中…':'确认'}</button></footer></form></CollectionDialog>}</>
}

export function CollectionsView({sidebar=false,initialFolder='*',onOpen,onSelect,collapsible=true,onFolderChange}:{sidebar?:boolean;initialFolder?:string;onOpen?:(id:string)=>void;onSelect?:(item:Collection)=>void;collapsible?:boolean;onFolderChange?:(id:string)=>void}){
  const q=useCollections(),client=useQueryClient(),[expanded,setExpanded]=useState(()=>localStorage.getItem('collection-expanded')!=='false'),[folder,setFolder]=useState(initialFolder),[filter,setFilter]=useState(''),[searchOpen,setSearchOpen]=useState(false),[folderAction,setFolderAction]=useState<'rename'|'delete'|null>(null)
  const refresh=()=>void client.invalidateQueries({queryKey:['collections']})
  useEffect(()=>setFolder(initialFolder),[initialFolder])
  const folders=[{id:'*',name:'全部合集'},{id:'',name:'默认收藏夹'},...(q.data?.folders||[])]
  const active=folders.find(f=>f.id===folder)||folders[1],visible=!collapsible||expanded
  const toggle=()=>setExpanded(v=>{localStorage.setItem('collection-expanded',String(!v));return !v})
  const items=(q.data?.items||[]).filter(i=>(active.id==='*'||i.folderId===active.id)&&(!filter||i.title.toLowerCase().includes(filter.toLowerCase())))
  if(sidebar)return <section className="collections-sidebar"><div className="collections-heading"><button className="collections-collapse" aria-expanded={expanded} onClick={toggle}>{expanded?<ChevronDown size={16}/>:<ChevronRight size={16}/>}收藏合集</button>{expanded&&<FolderEditor action="create" onDone={refresh}/>}</div>{expanded&&<div className="collection-folder-list">{folders.map(f=><button key={f.id} onClick={()=>onOpen?.(f.id)}><Folder size={16}/><span>{f.name}</span><small>{q.data?.items.filter(i=>f.id==='*'||i.folderId===f.id).length||0}</small></button>)}</div>}</section>
  return <section className={`collections-view ${!collapsible?'collections-embedded':''}`}><div className="collections-heading">{collapsible?<button className="collections-collapse" aria-expanded={visible} onClick={toggle}>{visible?<ChevronDown size={18}/>:<ChevronRight size={18}/>}<h3>收藏合集</h3><small>{q.data?.items.length||0}</small></button>:<span className="collections-total">{q.data?.items.length||0} 个合集</span>}{visible&&<div className="collections-heading-actions"><button className="collection-icon" aria-label="搜索收藏合集" aria-expanded={searchOpen} onClick={()=>{setSearchOpen(v=>!v);setFilter('')}}><Search size={18}/></button><FolderEditor action="create" onDone={refresh}/></div>}</div>{visible&&<>
    <div className="collection-filters" role="group" aria-label="收藏夹分类">{folders.map(f=><button key={f.id} aria-pressed={active.id===f.id} onClick={()=>{setFolder(f.id);onFolderChange?.(f.id)}}>{f.name}</button>)}</div>
    {(searchOpen||active.id&&active.id!=='*')&&<div className="collections-toolbar">{searchOpen&&<label className="collections-search"><Search size={16}/><input autoFocus aria-label="搜索收藏合集" placeholder="搜索合集名称" value={filter} onChange={e=>setFilter(e.target.value)}/><button aria-label="关闭合集搜索" onClick={()=>{setFilter('');setSearchOpen(false)}}><X size={16}/></button></label>}{active.id&&active.id!=='*'&&<ActionMenu sheet label="收藏夹管理">{close=><><button role="menuitem" onClick={()=>{close();setFolderAction('rename')}}>重命名收藏夹</button><button role="menuitem" onClick={()=>{close();setFolderAction('delete')}}>删除收藏夹</button></>}</ActionMenu>}</div>}
    {q.error&&<p className="inline-error">{commandErrorMessage(q.error)}<button onClick={()=>void q.refetch()}>重试</button></p>}
    {!q.isLoading&&!items.length&&<p className="collection-empty">{filter?'没有匹配的合集':'点击搜索结果中的书签，收藏合集；打开后选择想听的歌曲。'}</p>}
    {folderAction&&<FolderEditor key={`${active.id}:${folderAction}`} action={folderAction} id={active.id} initial={active.name} controlledOpen onClose={()=>setFolderAction(null)} onDone={()=>{if(folderAction==='delete'){setFolder('');onFolderChange?.('')}refresh()}}/>}
    <div className="collection-cards">{items.map(item=><CollectionCard key={item.bvid} item={item} onOpen={()=>onSelect?.(item)}/>)}</div>
  </>}</section>
}
function CollectionCard({item,onOpen}:{item:Collection;onOpen:()=>void}){
  const [context,setContext]=useState<{left:number;top:number;nonce:number}>()
  return <article onContextMenu={e=>{e.preventDefault();setContext({left:e.clientX,top:e.clientY,nonce:Date.now()})}}><button className="collection-card-main" onClick={onOpen}><Artwork src={item.coverUrl}/><span className="collection-card-copy"><strong>{item.title||`合集 ${item.bvid}`}</strong><small>{item.uploaderName||'打开查看分 P'}</small></span></button><CollectionMenu item={item} onOpen={onOpen} contextPosition={context}/></article>
}

export function CollectionDetail({item,onBack}:{item:Collection;onBack:()=>void}){
  const q=useQuery({queryKey:['collection-parts',item.bvid],queryFn:()=>getVideoParts(item.bvid)}),[filter,setFilter]=useState(''),[searchOpen,setSearchOpen]=useState(false),[context,setContext]=useState<{left:number;top:number;nonce:number}>()
  const client=useQueryClient(),compact=useCompactLayout()
  useEffect(()=>{const d=q.data;if(!d)return;void invoke('collections_change',{action:'cache',item:{bvid:d.bvid,folderId:'',title:d.title,coverUrl:d.coverUrl,uploaderName:d.uploaderName}}).then(()=>client.invalidateQueries({queryKey:['collections']})).catch(()=>undefined)},[q.data,client])
  const detail=q.data,player=usePlayerStore.getState(),tracks=detail?.parts.map(p=>toTrack(detail,p))||[]
  const run=(id=tracks[0]?.id)=>{if(id)void player.playFromList(tracks,id)}
  return <section className="collection-detail"><button className="collection-flat-button collection-back" onClick={onBack}><ArrowLeft size={17}/>返回收藏合集</button><header onContextMenu={e=>{e.preventDefault();setContext({left:e.clientX,top:e.clientY,nonce:Date.now()})}}><Artwork src={detail?.coverUrl||item.coverUrl}/><div><h2>{detail?.title||item.title||`合集 ${item.bvid}`}</h2><p>{detail?.uploaderName||item.uploaderName} {detail&&`· ${tracks.length} 个分 P`}</p></div><CollectionBookmark item={item}/><CollectionMenu item={item} contextPosition={context}/></header>
    <div className="collection-detail-toolbar"><button className="collection-primary" disabled={!tracks.length} onClick={()=>run()}><Play size={16}/>播放全部{tracks.length?` · ${tracks.length}`:''}</button><div><button className="collection-icon" aria-label="搜索分P" aria-expanded={searchOpen} onClick={()=>{setSearchOpen(v=>!v);setFilter('')}}><Search size={18}/></button><ActionMenu sheet label="合集播放选项">{close=><><button role="menuitem" disabled={!tracks.length} onClick={()=>{player.enqueue(tracks);close()}}><ListPlus size={16}/>全部加入队列</button><button role="menuitem" disabled={q.isFetching} onClick={()=>{void q.refetch();close()}}><RefreshCw size={16}/>刷新分 P</button></>}</ActionMenu></div></div>
    {searchOpen&&<label className="collections-search detail-search"><Search size={16}/><input autoFocus aria-label="搜索分P" placeholder="搜索分 P" value={filter} onChange={e=>setFilter(e.target.value)}/><button aria-label="关闭分P搜索" onClick={()=>{setSearchOpen(false);setFilter('')}}><X size={16}/></button></label>}
    {q.isLoading&&<p>正在加载分 P…</p>}{q.error&&<p className="inline-error">{commandErrorMessage(q.error)}<button className="collection-flat-button" onClick={()=>void q.refetch()}>重试</button></p>}
    {!q.isLoading&&!q.error&&!tracks.length&&<p className="collection-empty">暂无可播放的分 P</p>}
    <div className="parts-list">{tracks.filter(t=>t.title.toLowerCase().includes(filter.toLowerCase())).map(track=><div className="part-entry" key={track.id} onContextMenu={e=>showTrackMenu(e,track,undefined,tracks)}><button onClick={()=>run(track.id)}><span>P{track.source.page}</span><strong>{track.title}</strong>{!compact&&<small>{formatDuration(track.durationSeconds)}</small>}<Play size={14}/></button><TrackMenuButton track={track} tracks={tracks}/></div>)}</div>
  </section>
}
