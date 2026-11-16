import { accountQueryKey } from '../../services/queryKeys'
import {useState} from 'react'
import {useQuery,useQueryClient} from '@tanstack/react-query'
import {Bookmark} from 'lucide-react'
import {changeCollection,listCollections,type Collection} from '../../services/collections'
import {commandErrorMessage} from '../../services/desktopApi'
const useCollections = () => useQuery({queryKey:accountQueryKey('collections'),queryFn:listCollections})
type CollectionInfo = Omit<Collection,'folderId'>
export function CollectionBookmark({ item }: { item: CollectionInfo }) {
  const query=useCollections(),client=useQueryClient(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[optimistic,setOptimistic]=useState<boolean>()
  const saved=query.data?.items.find(i=>i.bvid===item.bvid)
  const active=optimistic??Boolean(saved)
  const toggle=async()=>{
    if(busy)return
    const next=!active;setOptimistic(next);setBusy(true);setError('')
    try{await changeCollection(saved?'remove':'save',item.bvid,'',{...item,folderId:''});await client.invalidateQueries({queryKey:accountQueryKey('collections')});setOptimistic(undefined)}
    catch(e){setOptimistic(active);setError(`收藏失败，已恢复原状态：${commandErrorMessage(e)}`)}finally{setBusy(false)}
  }
  return <><button className={`icon-action collection-bookmark ${active?'saved':''}`} aria-busy={busy} disabled={query.isLoading} aria-label={active?'取消收藏合集':'收藏整个合集'} aria-pressed={active} title={active?'取消收藏合集':'收藏整个合集'} onClick={()=>void toggle()}><Bookmark size={18} fill={active?'currentColor':'none'}/></button>{error&&<span role="alert" className="inline-error">{error}</span>}</>
}

