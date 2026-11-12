import type { MenuPosition } from '../../shared/useRowContextMenu'
import { FolderEditor } from './CollectionFolderControls'
import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { Check, ChevronDown, ChevronRight, UserRoundPlus, UserRound, Search, FolderPlus, Folder, Pencil, LoaderCircle } from 'lucide-react'
import { TouchOptions } from '../../shared/TouchOptions'
import { ActionMenu } from '../../shared/ActionMenu'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { Artwork } from '../../shared/Artwork'
import { LoadMore } from '../../shared/LoadMore'
import { accountEpoch } from '../../services/accountScope'
import { changeCollection, type Collection, type CollectionFolder } from '../../services/collections'
import { commandErrorMessage } from '../../services/desktopApi'

export function CreatorActions({ item, folders, contextPosition }: { item: Collection; folders: CollectionFolder[];contextPosition?:MenuPosition }) {
  const client = useQueryClient()
  const [editing, setEditing] = useState(false), [note, setNote] = useState(item.note || ''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [context, setContext] = useState<{left:number;top:number;nonce:number}>()
  const save = async (action: 'note'|'move', value: string) => {
    setBusy(true); setError('')
    try { await changeCollection(action, item.bvid, value); await client.invalidateQueries({queryKey:['collections']}); setEditing(false) }
    catch(cause) { setError(commandErrorMessage(cause)) } finally { setBusy(false) }
  }
  return <div className="creator-actions" onContextMenu={event => { event.preventDefault(); setContext({left:event.clientX,top:event.clientY,nonce:Date.now()}) }}>
    <ActionMenu label="UP 主操作" contextPosition={contextPosition||context} sheet>{close => <>
      <button onClick={() => { close(); setNote(item.note || ''); setEditing(true) }}><Pencil size={16}/>修改备注</button>
      <small className="creator-menu-label">移动到分组</small>
      {[{id:'',name:'未分组'},...folders].map(group=><button key={group.id} onClick={() => { close(); void save('move',group.id) }}>{group.name}{item.folderId===group.id&&<Check size={16}/>}</button>)}
    </>}</ActionMenu>
    {editing&&<CollectionDialog title="UP 主备注" onClose={()=>setEditing(false)}><form className="creator-note-form" onSubmit={event=>{event.preventDefault();void save('note',note)}}><label>{item.title}<input autoFocus aria-label="UP 主备注" maxLength={160} value={note} onChange={event=>setNote(event.target.value)} placeholder="添加备注，原昵称会保留"/></label><button className="collection-primary" disabled={busy}>保存</button>{error&&<p role="alert">{error}</p>}</form></CollectionDialog>}
    {!editing&&error&&<p role="alert">{error}</p>}
  </div>
}

type Following = { mid:number; uname:string; face:string; sign?:string }
export function CreatorManager({ folders, items, sidebar = false, expanded = true, onToggle }: { folders:CollectionFolder[];items:Collection[];sidebar?:boolean;expanded?:boolean;onToggle?:()=>void }) {
  const client=useQueryClient(), epoch=accountEpoch()
  const [importOpen,setImportOpen]=useState(false),[groupOpen,setGroupOpen]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('')
  const [chosen,setChosen]=useState<Set<number>>(new Set()),[destination,setDestination]=useState(''),[busy,setBusy]=useState(false),[filter,setFilter]=useState('')
  const alive=useRef(true), importing=useRef(false), cancelImport=useRef(false)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  const query=useInfiniteQuery({queryKey:['bili-following',epoch],initialPageParam:1,queryFn:({pageParam})=>invoke<{page:number;data:{list:Following[];total:number}}>('bili_creator_catalog',{action:'following',page:pageParam}),enabled:importOpen,getNextPageParam:last=>last.data.list?.length&&last.page*50<last.data.total?last.page+1:undefined,retry:false})
  const imported=new Set(items.map(item=>Number(item.bvid.slice(3))))
  const rows=[...new Map((query.data?.pages.flatMap(page=>page.data.list||[])||[]).map(up=>[up.mid,up])).values()]
  const visibleRows=rows.filter(up=>up.uname.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const available=visibleRows.filter(up=>!imported.has(up.mid))
  const allChosen=available.length>0&&available.every(up=>chosen.has(up.mid))
  const importChosen=async()=>{
    if(importing.current)return;importing.current=true;cancelImport.current=false;setBusy(true);setError('');let count=0
    try { for(const up of rows.filter(up=>chosen.has(up.mid)&&!imported.has(up.mid))) {
      if(!alive.current||accountEpoch()!==epoch)return
      if(cancelImport.current)break
      await changeCollection('save','','',{bvid:`up:${up.mid}`,folderId:destination,title:up.uname,coverUrl:up.face,uploaderName:up.uname});count++
    }
    if(alive.current&&accountEpoch()===epoch){setMessage(`已导入 ${count} 位 UP 主`);setChosen(new Set());setImportOpen(false);if(sidebar&&!expanded)onToggle?.()}
    }catch(cause){if(alive.current)setError(`已导入 ${count} 位。${commandErrorMessage(cause)}`)}finally{importing.current=false;if(alive.current){setBusy(false);void client.invalidateQueries({queryKey:['collections']})}}
  }
  return <>
    {sidebar ? <div className="section-heading creator-sidebar-heading"><button className="sidebar-collapse" aria-expanded={expanded} onClick={onToggle}>关注{expanded?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button><div className="sidebar-heading-actions" hidden={sidebar&&!expanded}><button className="collection-icon" title="新建关注文件夹" aria-label="新建关注文件夹" onClick={()=>{setError('');setGroupOpen(true)}}><FolderPlus size={18}/></button><button className="collection-icon creator-import-entry" title="从 B站导入关注" aria-label="从 B站导入关注" onClick={()=>{setError('');setFilter('');setDestination('');setChosen(new Set());setImportOpen(true)}}><UserRoundPlus size={18}/><span>导入</span></button></div></div> : <div className="creators-tools"><span className="hub-summary">{items.length} 位 UP 主</span><div className="sidebar-heading-actions" hidden={sidebar&&!expanded}><button className="collection-icon" title="新建关注文件夹" aria-label="新建关注文件夹" onClick={()=>{setError('');setGroupOpen(true)}}><FolderPlus size={18}/></button><button className="collection-icon creator-import-entry" title="从 B站导入关注" aria-label="从 B站导入关注" onClick={()=>{setError('');setFilter('');setDestination('');setChosen(new Set());setImportOpen(true)}}><UserRoundPlus size={18}/><span>导入</span></button></div></div>}
    {message&&<p className="batch-message" role="status">{message}</p>}
    <FolderEditor creator action="create" controlledOpen={groupOpen} onClose={()=>setGroupOpen(false)} onDone={()=>{setGroupOpen(false);void client.invalidateQueries({queryKey:['collections']});if(sidebar&&!expanded)onToggle?.()}}/>
    {importOpen&&<CollectionDialog title="导入 B站关注" onClose={()=>{cancelImport.current=true;setImportOpen(false)}} className="creator-import-dialog"><div className="creator-import-toolbar"><TouchOptions label="分组" icon={<Folder size={16}/>} selected={destination} options={[{value:'',label:'未分组'},...folders.map(group=>({value:group.id,label:group.name}))]} disabled={busy} onChange={setDestination}/><button disabled={busy||!available.length} className="creator-select-all" aria-pressed={allChosen} onClick={()=>setChosen(previous=>{const next=new Set(previous);available.forEach(up=>allChosen?next.delete(up.mid):next.add(up.mid));return next})}><Check size={15}/>{allChosen?'取消全选':'全选'}</button></div>
      <label className="creator-import-search"><Search size={16}/><input type="search" aria-label="查找 B站关注的 UP 主" placeholder="查找 UP 主" value={filter} onChange={event=>setFilter(event.target.value)}/><small>{query.data?.pages[0]?.data.total ?? rows.length} 位</small></label>
      {(error||query.error)&&<p role="alert">{error||commandErrorMessage(query.error)}</p>}{query.isLoading&&<p><LoaderCircle className="spin" size={16}/>读取关注中…</p>}
      <div className="creator-import-list">{visibleRows.map(up=><label className="creator-select-row" data-checked={imported.has(up.mid)||chosen.has(up.mid)||undefined} data-imported={imported.has(up.mid)||undefined} key={up.mid}><input type="checkbox" disabled={busy||imported.has(up.mid)} checked={imported.has(up.mid)||chosen.has(up.mid)} onChange={event=>setChosen(previous=>{const next=new Set(previous);if(event.target.checked)next.add(up.mid);else next.delete(up.mid);return next})}/><Artwork src={up.face} fallback={<span className="creator-avatar-initial">{up.uname.slice(0,1)||<UserRound size={22}/>}</span>}/><span className="creator-import-copy"><strong>{up.uname}</strong>{up.sign&&<small>{up.sign}</small>}</span>{imported.has(up.mid)?<small className="creator-imported-label">已关注</small>:<span className="creator-select-check" aria-hidden="true"><Check size={15}/></span>}</label>)}{!visibleRows.length&&!query.isLoading&&<p className="creator-import-empty">{filter?'没有找到匹配的 UP 主':'暂无可导入的关注'}</p>}{query.hasNextPage&&<LoadMore key={query.data?.pages.length} busy={query.isFetchingNextPage} automatic={importOpen&&!query.isFetchNextPageError} presentation={query.isFetchNextPageError?'button':'status'} onLoad={()=>void query.fetchNextPage()} label={query.isFetchNextPageError?'重试加载':'继续滚动自动加载'}/>}</div>

      <footer><span>已选择 <strong>{chosen.size}</strong> 位</span><button className="collection-primary" disabled={busy||!chosen.size} onClick={()=>void importChosen()}>{busy?<LoaderCircle size={16} className="spin"/>:<UserRoundPlus size={16}/>}<span>{busy?'正在导入…':'导入关注'}</span></button></footer>
    </CollectionDialog>}
  </>
}
