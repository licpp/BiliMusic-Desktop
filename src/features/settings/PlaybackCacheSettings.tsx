import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query'
import {invoke} from '@tauri-apps/api/core'
import {HardDrive,LoaderCircle,Trash2} from 'lucide-react'
import {commandErrorMessage,inDesktopShell} from '../../services/desktopApi'
type CacheStatus={limitBytes:number;usedBytes:number;tracks:number;completeTracks:number}
const size=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(1)} GB`:`${(bytes/1024**2).toFixed(1)} MB`
const limits=[{value:0,label:'不缓存'},{value:128,label:'128 MB'},{value:256,label:'256 MB'},{value:512,label:'512 MB'},{value:1024,label:'1 GB'},{value:2048,label:'2 GB'},{value:5120,label:'5 GB'},{value:10240,label:'10 GB'}]
export function PlaybackCacheSettings({embedded=false}:{embedded?:boolean}={}){
  const client=useQueryClient()
  const status=useQuery({queryKey:['playback-cache'],queryFn:()=>invoke<CacheStatus>('playback_cache_status'),enabled:inDesktopShell,refetchInterval:10000,staleTime:0})
  const update=useMutation({mutationFn:(megabytes:number)=>invoke<CacheStatus>('playback_cache_limit',{megabytes}),onSuccess:data=>client.setQueryData(['playback-cache'],data)})
  const clear=useMutation({mutationFn:()=>invoke<CacheStatus>('playback_cache_clear'),onSuccess:data=>client.setQueryData(['playback-cache'],data)})
  const busy=update.isPending||clear.isPending
  const data=status.data,error=update.error||clear.error||status.error
  const selected=data?Math.round(data.limitBytes/1024**2):null
  const capacity=limits.find(option=>option.value===selected)?.label||size(data?.limitBytes||0)
  return <div className={`playback-cache-settings ${embedded?'playback-cache-embedded':'settings-card'}`}>
    {!embedded&&<div className="settings-icon"><HardDrive/></div>}
    <div className="playback-cache-copy">{!embedded&&<strong>播放缓存</strong>}<small>边听边缓存，重复播放优先使用缓存。离线可播放已缓存的片段。</small>{data&&<><span className="playback-cache-usage">已用 {size(data.usedBytes)}{data.limitBytes?` / ${size(data.limitBytes)}`:' · 已关闭'}</span><progress aria-label="播放缓存使用量" max={Math.max(1,data.limitBytes)} value={Math.min(data.usedBytes,data.limitBytes)}/></>}</div>
    <div className="playback-cache-actions">
      <button type="button" className="cache-clear-button" disabled={!data||!data.usedBytes||busy} onClick={()=>clear.mutate()} title="清理播放缓存，不影响下载和歌单">{clear.isPending?<LoaderCircle size={16} className="spin"/>:<Trash2 size={16}/>}清理</button>
    </div>
    <div className="cache-capacity-setting">
      <div className="cache-capacity-heading"><strong>缓存容量上限</strong><span aria-live="polite">{update.isPending&&<LoaderCircle size={14} className="spin"/>}{data?capacity:'正在读取…'}</span></div>
      <div className="cache-capacity-options" role="group" aria-label="缓存容量上限">{limits.map(option=><button type="button" key={option.value} aria-pressed={selected===option.value} disabled={!data||busy} onClick={()=>{if(selected!==option.value)update.mutate(option.value)}}>{option.label}</button>)}</div>
    </div>
    {error&&<p className="inline-error" role="alert">{commandErrorMessage(error)}</p>}
  </div>
}
