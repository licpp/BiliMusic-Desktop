import { CollectionDialog } from '../../shared/CollectionDialog'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Bookmark, Check, ChevronDown, ChevronRight, Folder, FolderInput, ListPlus, Play, Plus, RefreshCw, Search, X } from 'lucide-react'
import { changeCollection, listCollections, type Collection } from '../../services/collections'
import { commandErrorMessage, getVideoParts, type Playlist } from '../../services/desktopApi'
import { Artwork } from '../../shared/Artwork'
import { ActionMenu } from '../../shared/ActionMenu'
import { toTrack } from '../../services/collectionTrack'
import { usePlayerStore } from '../player/playerStore'
import { VideoPartsList } from '../library/VideoPartsList'
import { PlaylistEntry } from '../library/PlaylistEntry'
import { useCompactLayout } from '../../shared/useCompactLayout'
import { useRowContextMenu } from '../../shared/useRowContextMenu'
import { accountEpoch } from '../../services/accountScope'
import { CollectionDragHandle } from './CollectionDragHandle'

const useCollections = () => useQuery({ queryKey: ['collections'], queryFn: listCollections })
type CollectionInfo = Omit<Collection, 'folderId'>

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

export function CollectionsView({ sidebar = false, folderId, linkedFolders = [], onOpenFolder, onOpenLinked, onLinkedRemoved, onSelect, onFolderRemoved }: {
  sidebar?: boolean
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
  const folders = query.data?.folders || []
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
  const items = query.data?.items || []
  const needle = filter.trim().toLowerCase()
  const matches = (value: string) => value.toLowerCase().includes(needle)
  const visibleItems = items.filter(item => (root && needle ? true : item.folderId === (folderId || '')) && matches(item.title || item.bvid))
  const folder = folders.find(item => item.id === folderId)
  const children = root ? <>
    {folders.filter(item => matches(item.name)).map(folder => {
      const contents = items.filter(item => item.folderId === folder.id)
      return <FolderEntry key={folder.id} folder={folder} count={contents.length} coverUrl={contents[0]?.coverUrl}
        onOpen={() => onOpenFolder(folder.id)} onChanged={refresh} onRemoved={() => onFolderRemoved?.(folder.id)} />
    })}
    {linkedFolders.filter(item => matches(item.name)).map(item => <PlaylistEntry
      key={item.id} playlist={item} sidebar={sidebar} onOpen={() => onOpenLinked(item.id)} onRemoved={() => onLinkedRemoved(item.id)}
    />)}
  </> : null
  const toggle = () => setExpanded(previous => {
    localStorage.setItem('collection-expanded', String(!previous))
    return !previous
  })
  const entries = <div className="collection-cards">
    {visibleItems.map(item => <CollectionCard key={item.bvid} item={item} onOpen={() => onSelect(item)}
      onMove={(root || !compact) && folders.some(folder => folder.id !== item.folderId) && !move.isPending ? target => move.mutate({ item, target }) : undefined}/>)}
    {children}
  </div>
  if (sidebar) return <section className="collections-sidebar">
    <div className="collections-heading">
      <button type="button" className="collections-collapse" aria-expanded={expanded} onClick={toggle}>
        {expanded ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}收藏合集
      </button>
      {expanded && <FolderEditor action="create" onDone={refresh}/>}
    </div>
    {expanded && entries}
    {moveError}
  </section>
  return <section className="collections-view collections-embedded">
    <div className="collections-heading">
      <h3>{folder?.name || '收藏合集'}</h3>
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
  contextPosition?: ReturnType<typeof useRowContextMenu>['position']
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

function FolderEntry({ folder, count, coverUrl, onOpen, onChanged, onRemoved }: {
  folder: FolderInfo; count: number; coverUrl?: string; onOpen: () => void; onChanged: () => void; onRemoved: () => void
}) {
  const { position, onContextMenu } = useRowContextMenu()
  return <article className="collection-folder-entry" data-collection-folder={folder.id} onContextMenu={onContextMenu}>
    <button type="button" className="collection-card-main" onClick={onOpen}>
      <Artwork src={coverUrl} fallback={<Folder aria-hidden="true"/>}/>
      <span className="collection-card-copy"><strong>{folder.name}</strong><small>{count} 个合集</small></span>
    </button>
    <FolderMenu folder={folder} onOpen={onOpen} contextPosition={position} onChanged={onChanged} onRemoved={onRemoved}/>
  </article>
}

function CollectionCard({ item, onOpen, onMove }: { item: Collection; onOpen: () => void; onMove?: (target: string) => void }) {
  const { position, onContextMenu } = useRowContextMenu()
  return <article onContextMenu={onContextMenu}>
    {onMove && <CollectionDragHandle title={item.title || item.bvid} folderId={item.folderId} onMove={onMove}/>}
    <button type="button" className="collection-card-main" onClick={onOpen}>
      <Artwork src={item.coverUrl}/>
      <span className="collection-card-copy"><strong>{item.title || `合集 ${item.bvid}`}</strong><small>{item.uploaderName || '打开查看分 P'}</small></span>
    </button>
    <CollectionMenu item={item} onOpen={onOpen} contextPosition={position}/>
  </article>
}

export function CollectionDetail({item,onBack,fromSearch=false}:{item:Collection;onBack:()=>void;fromSearch?:boolean}){
  const q=useQuery({queryKey:['collection-parts',item.bvid],queryFn:()=>getVideoParts(item.bvid)}),[filter,setFilter]=useState(''),[searchOpen,setSearchOpen]=useState(false),[context,setContext]=useState<{left:number;top:number;nonce:number}>()
  const client=useQueryClient()
  useEffect(()=>{const d=q.data;if(!d)return;void invoke('collections_change',{action:'cache',item:{bvid:d.bvid,folderId:'',title:d.title,coverUrl:d.coverUrl,uploaderName:d.uploaderName}}).then(()=>client.invalidateQueries({queryKey:['collections']})).catch(()=>undefined)},[q.data,client])
  const detail=q.data,player=usePlayerStore.getState(),tracks=detail?.parts.map(p=>toTrack(detail,p))||[]
  const visibleTracks = tracks.filter(track => track.title.toLowerCase().includes(filter.toLowerCase()))
  const run=(id=tracks[0]?.id)=>{if(id)void player.playFromList(tracks,id)}
  return <section className="collection-detail"><button className="collection-flat-button collection-back" onClick={onBack}><ArrowLeft size={17}/>{fromSearch?'返回搜索结果':'返回收藏合集'}</button><header onContextMenu={e=>{e.preventDefault();setContext({left:e.clientX,top:e.clientY,nonce:Date.now()})}}><Artwork src={detail?.coverUrl||item.coverUrl}/><div><h2>{detail?.title||item.title||`合集 ${item.bvid}`}</h2><p>{detail?.uploaderName||item.uploaderName} {detail&&`· ${tracks.length} 个分 P`}</p></div><CollectionBookmark item={item}/><CollectionMenu item={item} contextPosition={context}/></header>
    <div className="collection-detail-toolbar"><button className="collection-primary" disabled={!tracks.length} onClick={()=>run()}><Play size={16}/>播放全部{tracks.length?` · ${tracks.length}`:''}</button><div><button className="collection-icon" aria-label="搜索分P" aria-expanded={searchOpen} onClick={()=>{setSearchOpen(v=>!v);setFilter('')}}><Search size={18}/></button><ActionMenu sheet label="合集播放选项">{close=><><button role="menuitem" disabled={!tracks.length} onClick={()=>{player.enqueue(tracks);close()}}><ListPlus size={16}/>全部加入队列</button><button role="menuitem" disabled={q.isFetching} onClick={()=>{void q.refetch();close()}}><RefreshCw size={16}/>刷新分 P</button></>}</ActionMenu></div></div>
    {searchOpen&&<label className="collections-search detail-search"><Search size={16}/><input autoFocus aria-label="搜索分P" placeholder="搜索分 P" value={filter} onChange={e=>setFilter(e.target.value)}/><button aria-label="关闭分P搜索" onClick={()=>{setSearchOpen(false);setFilter('')}}><X size={16}/></button></label>}
    {q.isLoading&&<p>正在加载分 P…</p>}{q.error&&<p className="inline-error">{commandErrorMessage(q.error)}<button className="collection-flat-button" onClick={()=>void q.refetch()}>重试</button></p>}
    {!q.isLoading&&!q.error&&!tracks.length&&<p className="collection-empty">暂无可播放的分 P</p>}
    <VideoPartsList tracks={tracks} visibleTracks={visibleTracks} />
  </section>
}
