import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { Track } from '../../domain/track'
import { commandErrorMessage } from '../../services/desktopApi'
import { getMediaOptions,getMediaPreferences,setMediaPreferences } from '../../services/mediaSources'
import { reloadCurrentAudioSource } from '../player/playerStore'
export function PlaybackSettings({track,onVideoChange}:{track:Track;onVideoChange:()=>void}) {
  const client=useQueryClient()
  const options=useQuery({queryKey:['media-options',track.id],queryFn:()=>getMediaOptions(track.source.bvid,track.source.cid),staleTime:60000,enabled:track.source.provider==='bilibili'})
  const preferences=useQuery({queryKey:['media-preferences'],queryFn:getMediaPreferences})
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const change=async(kind:'audioId'|'videoHeight',value:number)=>{
    setBusy(true);setError('')
    try {const updated=await setMediaPreferences({[kind]:value});client.setQueryData(['media-preferences'],updated);if(kind==='audioId')await reloadCurrentAudioSource();else onVideoChange()}
    catch(error){setError(commandErrorMessage(error))}finally{setBusy(false)}
  }
  if(track.source.provider!=='bilibili')return null
  return <div className="playback-quality-settings">
    <label>音质<select aria-label="音频质量" disabled={busy||!preferences.data||!options.data} value={preferences.data?.audioId||0} onChange={e=>void change('audioId',Number(e.target.value))}><option value={0}>自动 · 最佳可用</option>{options.data?.audio.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}{preferences.data?.audioId&&!options.data?.audio.some(o=>o.id===preferences.data!.audioId)?<option value={preferences.data.audioId}>已记住偏好 · 本曲使用可用音质</option>:null}</select></label>
    <label>清晰度<select aria-label="视频清晰度" disabled={busy||!preferences.data||!options.data} value={preferences.data?.videoHeight||0} onChange={e=>void change('videoHeight',Number(e.target.value))}><option value={0}>自动</option>{options.data?.video.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}{preferences.data?.videoHeight&&!options.data?.video.some(o=>o.id===preferences.data!.videoHeight)?<option value={preferences.data.videoHeight}>已记住偏好 · 本片自动适配</option>:null}</select></label>
    {(error||options.error||preferences.error)&&<p role="alert">{error||commandErrorMessage(options.error||preferences.error)}</p>}
    <small role="status">{busy?'正在切换…':'音质设置用于在线播放'}</small>
  </div>
}
