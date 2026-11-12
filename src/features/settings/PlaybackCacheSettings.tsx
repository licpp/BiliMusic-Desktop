import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query'
import {invoke} from '@tauri-apps/api/core'
import {Check,ChevronDown,HardDrive,LoaderCircle,Trash2} from 'lucide-react'
import {commandErrorMessage,inDesktopShell} from '../../services/desktopApi'
import {ActionMenu} from '../../shared/ActionMenu'
import {useCompactLayout} from '../../shared/useCompactLayout'
type CacheStatus={limitBytes:number;usedBytes:number;tracks:number;completeTracks:number}
const size=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(1)} GB`:`${(bytes/1024**2).toFixed(1)} MB`
const limits=[{value:0,label:'不缓存'},{value:128,label:'128 MB'},{value:256,label:'256 MB'},{value:512,label:'512 MB'},{value:1024,label:'1 GB'},{value:2048,label:'2 GB'},{value:5120,label:'5 GB'},{value:10240,label:'10 GB'}]
export function PlaybackCacheSettings(){
  const compact=useCompactLayout()
  const client=useQueryClient()
  const status=useQuery({queryKey:['playback-cache'],queryFn:()=>invoke<CacheStatus>('playback_cache_status'),enabled:inDesktopShell,refetchInterval:10000,staleTime:0})
  const update=useMutation({mutationFn:(megabytes:number)=>invoke<CacheStatus>('playback_cache_limit',{megabytes}),onSuccess:data=>client.setQueryData(['playback-cache'],data)})
  const clear=useMutation({mutationFn:()=>invoke<CacheStatus>('playback_cache_clear'),onSuccess:data=>client.setQueryData(['playback-cache'],data)})
  const busy=update.isPending||clear.isPending
  const data=status.data,error=update.error||clear.error||status.error
  const selected=data?Math.round(data.limitBytes/1024**2):512
  const capacity=limits.find(option=>option.value===selected)?.label||size(data?.limitBytes||0)
  return <div className="settings-card playback-cache-settings">
    <div className="settings-icon"><HardDrive/></div>
    <div className="playback-cache-copy"><strong>播放缓存</strong><small>边听边缓存，重复播放优先使用缓存。离线可播放已缓存的片段。</small>{data&&<><span className="playback-cache-usage">已用 {size(data.usedBytes)}{data.limitBytes?` / ${size(data.limitBytes)}`:' · 已关闭'}</span><progress aria-label="播放缓存使用量" max={Math.max(1,data.limitBytes)} value={Math.min(data.usedBytes,data.limitBytes)}/></>}</div>
    <div className="playback-cache-actions">
      <div className="cache-limit-selector">{!data||busy?<button type="button" className="cache-limit-pending" disabled aria-label="播放缓存上限"><span>{capacity}</span><ChevronDown size={14}/></button>:<ActionMenu label="播放缓存上限" panelClassName="cache-limit-menu" sheet touchSheet={compact} icon={<><span>{capacity}</span><ChevronDown size={14}/></>}>
        {close=><><p className="cache-limit-heading">缓存容量上限</p><div className="cache-limit-options">{limits.map(option=><button type="button" key={option.value} role="menuitemradio" aria-checked={selected===option.value} onClick={()=>{close();if(selected!==option.value)update.mutate(option.value)}}><span>{option.label}</span>{selected===option.value&&<Check size={14}/>}</button>)}</div></>}
      </ActionMenu>}</div>
      <button type="button" className="cache-clear-button" disabled={!data||!data.usedBytes||busy} onClick={()=>clear.mutate()} title="清理播放缓存，不影响下载和歌单">{clear.isPending?<LoaderCircle size={16} className="spin"/>:<Trash2 size={16}/>}清理</button>
    </div>
    {error&&<p className="inline-error" role="alert">{commandErrorMessage(error)}</p>}
  </div>
}
