import { accountQueryKey } from '../../services/queryKeys'
import { useState } from 'react'
import { useQuery,useQueryClient } from '@tanstack/react-query'
import { Download, LoaderCircle, Headphones, FileAudio } from 'lucide-react'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { accountEpoch } from '../../services/accountScope'
import { getMediaOptions } from '../../services/mediaSources'
import { commandErrorMessage,getVideoParts } from '../../services/desktopApi'
import { startDownloadBatch,useDownloadBatch } from './downloadBatch'
import { useDownloadRequest,type DownloadOptions } from './downloadRequest'
import { isAndroid } from '../../services/platform'
import { androidDownloadDestination, androidDownloadDestinationKey } from '../../services/androidDownloads'
import { AndroidDownloadDestinationField } from './AndroidDownloadDestination'
import { downloadOptionsStorageKey as storageKey, rememberedDownloadOptions as remembered, batchDownloadChoices as batchChoices } from './downloadOptions'
export function DownloadDialogHost(){const request=useDownloadRequest(state=>state.request);return request?<DownloadDialog key={`${accountEpoch()}:${request.tracks.map(t=>t.id).join(',')}`} request={request}/>:null}
function DownloadDialog({request}:{request:NonNullable<ReturnType<typeof useDownloadRequest.getState>['request']>}){
 const client=useQueryClient(),batchBusy=useDownloadBatch(state=>state.busy)
 const [options,setOptions]=useState(remembered),[starting,setStarting]=useState(false),[error,setError]=useState('')
 const destination=useQuery({queryKey:androidDownloadDestinationKey,queryFn:()=>androidDownloadDestination(),enabled:isAndroid,retry:false})
 const single=request.tracks.length===1,track=request.tracks[0]
 const quality=useQuery({queryKey:accountQueryKey('download-options', track.id),queryFn:async()=>{const cid=track.source.cid>0?track.source.cid:(await getVideoParts(track.source.bvid)).parts[0]?.cid;if(!cid)throw new Error('暂无可下载的音频');return getMediaOptions(track.source.bvid,cid)},enabled:single,retry:false,staleTime:60000})
 const choices=single?quality.data?.audio||[]:batchChoices
 const missing=options.audioId!==0 && !choices.some(choice=>choice.id===options.audioId)
 const formatMissing=options.exportFormat==='flac'&&single&&!!quality.data&&!choices.some(choice=>choice.id===30251)
 const busy=starting||batchBusy
 const close=()=>{if(!starting)useDownloadRequest.setState({request:null})}
 const submit=async()=>{const scope=accountEpoch();setStarting(true);setError('');try{
  if(await startDownloadBatch(request.tracks,client,{...options,directory:request.directory,skipExisting:request.tracks.length>1})){
   if(scope!==accountEpoch())return
   try{localStorage.setItem(storageKey,JSON.stringify(options))}catch{}
   useDownloadRequest.setState({request:null})
  }else if(useDownloadBatch.getState().busy)setError('已有下载任务正在进行，请完成后重试')
 }catch(cause){setError(commandErrorMessage(cause))}finally{setStarting(false)}}
 return <CollectionDialog mobileSheet title="下载歌曲" className="download-quality-dialog" onClose={close}>
  <div className="download-selection-summary"><strong>{single?track.title:`已选 ${request.tracks.length} 首歌曲`}</strong><p>单独选择下载音质，记住你这次的选择。</p></div>
  <div className="download-option-field"><span><Headphones size={18}/>下载音质</span><div className="download-quality-options" role="radiogroup" aria-label="下载音质">
   {[{id:0,label:'自动 · 最高 AAC 音质'},...choices].map(choice=><label key={choice.id} data-selected={options.audioId===choice.id}><input type="radio" name="download-audio-quality" value={choice.id} checked={options.audioId===choice.id} disabled={busy} onChange={()=>setOptions(value=>({...value,audioId:choice.id,exportFormat:choice.id!==30251&&value.exportFormat==='flac'?'auto':value.exportFormat}))}/><span>{choice.label}</span></label>)}
  </div></div>
  <label className="download-option-field"><span><FileAudio size={18}/>保存格式</span><select aria-label="下载保存格式" disabled={busy} value={options.exportFormat} onChange={event=>setOptions(value=>({...value,exportFormat:event.target.value as DownloadOptions['exportFormat'],audioId:event.target.value==='flac'?30251:value.audioId}))}>
   <option value="auto">智能格式：无损 FLAC / AAC M4A</option><option value="flac" disabled={options.audioId!==0&&options.audioId!==30251||single&&!!quality.data&&!choices.some(choice=>choice.id===30251)}>FLAC（需无损音源）</option><option value="original">保留原始封装</option>
  </select></label>
  <p className="download-format-hint">{options.exportFormat==='original'?'按音源原本的封装保存。':options.exportFormat==='flac'?'无损提取 FLAC 音轨，保留原始采样率和位深。':'Hi-Res 保存为真正的 .flac，AAC 保存为 .m4a。'}</p>
  {isAndroid&&<AndroidDownloadDestinationField disabled={busy}/>}
  {single&&quality.isPending&&<p role="status" className="batch-message"><LoaderCircle size={15} className="spin"/>正在读取本曲可用音质…</p>}
  {single&&quality.isError&&<button className="load-more" onClick={()=>void quality.refetch()}>{commandErrorMessage(quality.error)} · 重试</button>}
  {missing&&!quality.isPending&&<p className="inline-error">这首歌没有上次选择的音质，请重新选择。</p>}
  {formatMissing&&<p className="inline-error">本曲没有无损音源，请选择智能格式或原始封装。</p>}
  {error&&<p className="inline-error" role="alert">{error}</p>}
  <footer><button type="button" className="collection-flat-button" disabled={starting} onClick={close}>取消</button><button type="button" className="collection-primary" disabled={busy||missing||formatMissing||isAndroid&&!destination.data?.available||single&&(quality.isPending||quality.isError)} onClick={()=>void submit()}>{starting?<LoaderCircle size={16} className="spin"/>:<Download size={16}/>}开始下载</button></footer>
 </CollectionDialog>
}
