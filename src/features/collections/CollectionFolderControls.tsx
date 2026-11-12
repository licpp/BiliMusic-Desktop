import { useEffect, useState } from 'react'
import { Folder, Plus } from 'lucide-react'
import { changeCollection } from '../../services/collections'
import { commandErrorMessage } from '../../services/desktopApi'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { ActionMenu } from '../../shared/ActionMenu'
import type { MenuPosition } from '../../shared/useRowContextMenu'

export function FolderEditor({action,id='',initial='',onDone,controlledOpen,onClose,creator=false}:{creator?:boolean;action:'create'|'rename'|'delete';id?:string;initial?:string;onDone:()=>void;controlledOpen?:boolean;onClose?:()=>void}){
  const [open,setOpen]=useState(false),[name,setName]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const visible=controlledOpen??open
  useEffect(()=>{if(visible){setName(initial);setError('')}},[visible,initial])
  const close=()=>{setOpen(false);onClose?.()}
  const kind=creator?'关注文件夹':'收藏夹'
  const title=action==='create'?`新建${kind}`:action==='rename'?`重命名${kind}`:`删除${kind}`
  return <>{controlledOpen===undefined&&<button className="collection-flat-button" aria-label={title} onClick={()=>{setName(initial);setError('');setOpen(true)}}>{action==='create'?<><Plus size={16}/><span>{title}</span></>:action==='rename'?'重命名':title}</button>}{visible&&<CollectionDialog title={title} onClose={close}><form onSubmit={async e=>{e.preventDefault();setBusy(true);try{await changeCollection(action==='create'&&creator?'createCreator':action,id,name);close();onDone()}catch(e){setError(commandErrorMessage(e))}finally{setBusy(false)}}}>{action==='delete'?<p>{creator?'里面的 UP 主会移回未分组，不会取消关注。':'里面的合集会移回默认收藏夹，不会取消收藏。'}</p>:<input aria-label={`${kind}名称`} value={name} maxLength={80} onChange={e=>setName(e.target.value)} placeholder={`${kind}名称`}/>}{error&&<p role="alert" className="inline-error">{error}</p>}<footer><button type="button" className="collection-flat-button" onClick={close}>取消</button><button className="collection-primary" type="submit" disabled={busy||(action!=='delete'&&!name.trim())}>{busy?'处理中…':'确认'}</button></footer></form></CollectionDialog>}</>
}

type FolderInfo = { id: string; name: string }

export function FolderMenu({ folder, contextPosition, onOpen, onChanged, onRemoved, creator=false }: {
  creator?: boolean
  folder: FolderInfo
  contextPosition?: MenuPosition
  onOpen?: () => void
  onChanged: () => void
  onRemoved: () => void
}) {
  const [action, setAction] = useState<'rename' | 'delete'>()
  return <>
    <ActionMenu sheet label={`${creator?'关注文件夹':'收藏夹'}操作：${folder.name}`} contextPosition={contextPosition}>{close => <>
      {onOpen && <button role="menuitem" onClick={() => { close(); onOpen() }}><Folder size={16}/>打开文件夹</button>}
      <button role="menuitem" onClick={() => { close(); setAction('rename') }}>重命名</button>
      <button role="menuitem" onClick={() => { close(); setAction('delete') }}>删除文件夹</button>
    </>}</ActionMenu>
    {action && <FolderEditor creator={creator} action={action} id={folder.id} initial={folder.name} controlledOpen
      onClose={() => setAction(undefined)} onDone={() => { if (action === 'delete') onRemoved(); onChanged() }} />}
  </>
}

