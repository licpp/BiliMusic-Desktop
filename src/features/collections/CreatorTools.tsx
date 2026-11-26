import { accountQueryKey } from '../../services/queryKeys'
import type { MenuPosition } from '../../shared/useRowContextMenu'
import { FolderEditor } from './CollectionFolderControls'
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, UserRoundPlus, UserRoundMinus, FolderPlus, Pencil, Plus } from 'lucide-react'
import { ActionMenu } from '../../shared/ActionMenu'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { changeCollection, type Collection, type CollectionFolder } from '../../services/collections'
import { commandErrorMessage } from '../../services/desktopApi'
import { FollowingImport } from './FollowingImport'
import { HubToolbar } from '../library/HubToolbar'

export function CreatorActions({ item, folders, contextPosition }: { item: Collection; folders: CollectionFolder[];contextPosition?:MenuPosition }) {
  const client = useQueryClient()
  const [editing, setEditing] = useState(false), [note, setNote] = useState(item.note || ''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [context, setContext] = useState<{left:number;top:number;nonce:number}>()
  const save = async (action: 'note'|'move'|'remove', value: string) => {
    setBusy(true); setError('')
    try { await changeCollection(action, item.bvid, value); await client.invalidateQueries({queryKey:accountQueryKey('collections')}); setEditing(false) }
    catch(cause) { setError(commandErrorMessage(cause)) } finally { setBusy(false) }
  }
  return <div className="creator-actions" onContextMenu={event => { event.preventDefault(); setContext({left:event.clientX,top:event.clientY,nonce:Date.now()}) }}>
    <ActionMenu label="UP 主操作" contextPosition={contextPosition||context} sheet>{close => <>
      <button onClick={() => { close(); setNote(item.note || ''); setEditing(true) }}><Pencil size={16}/>修改备注</button>
      <small className="creator-menu-label">移动到分组</small>
      {[{id:'',name:'未分组'},...folders].map(group=><button key={group.id} onClick={() => { close(); void save('move',group.id) }}>{group.name}{item.folderId===group.id&&<Check size={16}/>}</button>)}
      <button className="creator-unfollow-action" disabled={busy} onClick={() => { close(); void save('remove','') }}><UserRoundMinus size={16}/>取消关注</button>
    </>}</ActionMenu>
    {editing&&<CollectionDialog title="UP 主备注" onClose={()=>setEditing(false)}><form className="creator-note-form" onSubmit={event=>{event.preventDefault();void save('note',note)}}><label>{item.title}<input autoFocus aria-label="UP 主备注" maxLength={160} value={note} onChange={event=>setNote(event.target.value)} placeholder="添加备注，原昵称会保留"/></label><button className="collection-primary" disabled={busy}>保存</button>{error&&<p role="alert">{error}</p>}</form></CollectionDialog>}
    {!editing&&error&&<p role="alert">{error}</p>}
  </div>
}

export function CreatorManager({ items, sidebar = false, expanded = true, actionsHost, onToggle }: {
  items: Collection[]
  sidebar?: boolean
  expanded?: boolean
  actionsHost?: HTMLElement | null
  onToggle?: () => void
}) {
  const client = useQueryClient()
  const [importOpen, setImportOpen] = useState(false), [groupOpen, setGroupOpen] = useState(false)
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    const close = () => { setImportOpen(false); setBusy(false); setMessage('') }
    window.addEventListener('bilimusic-account-changing', close)
    return () => window.removeEventListener('bilimusic-account-changing', close)
  }, [])
  const openImport = () => { setMessage(''); setImportOpen(true) }
  return <>
    {sidebar ? <div className="section-heading creator-sidebar-heading">
      <button className="sidebar-collapse" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
        <span>关注</span>
        {items.length > 0 && <small className="sidebar-count">{items.length}</small>}
      </button>
      <div className="sidebar-heading-actions library-action-rail" hidden={sidebar && !expanded}>
        <ActionMenu panelClassName="sidebar-add-menu" label="导入或新建关注分组" icon={<Plus size={16}/>}>{close => <>
          <button role="menuitem" onClick={() => { close(); openImport() }}><UserRoundPlus size={16}/><span><strong>从 B 站导入关注</strong><small>批量选择已关注的 UP 主</small></span></button>
          <button role="menuitem" onClick={() => { close(); setGroupOpen(true) }}><FolderPlus size={16}/><span><strong>新建关注分组</strong><small>按主题归类关注的 UP 主</small></span></button>
        </>}</ActionMenu>
      </div>
    </div> : <HubToolbar className="creators-tools" summary={`${items.length} 位 UP 主`} actionsHost={actionsHost}
      actions={<div className="sidebar-heading-actions library-action-rail">
        <button type="button" className="collection-icon library-create-action" title="新建关注文件夹" aria-label="新建关注文件夹"
          onClick={() => { setGroupOpen(true) }}><FolderPlus size={18}/></button>
        <button type="button" className="collection-icon creator-import-entry library-import-action" title="从 B站导入关注" aria-label="从 B站导入关注"
          onClick={openImport}><UserRoundPlus size={18}/><span>导入</span></button>
      </div>}/>}
    {message&&<p className="batch-message" role="status">{message}</p>}
    <FolderEditor creator action="create" controlledOpen={groupOpen} onClose={()=>setGroupOpen(false)} onDone={()=>{setGroupOpen(false);void client.invalidateQueries({queryKey:accountQueryKey('collections')});if(sidebar&&!expanded)onToggle?.()}}/>
    {importOpen && <CollectionDialog mobileSheet title="导入 B 站关注" onClose={() => { setImportOpen(false); setBusy(false) }} className="creator-import-dialog">
      <FollowingImport busy={busy} onBusyChange={setBusy} onDone={count => {
        setMessage(`已导入 ${count} 位 UP 主`)
        setImportOpen(false)
        if (sidebar && !expanded) onToggle?.()
      }}/>
    </CollectionDialog>}
  </>
}
