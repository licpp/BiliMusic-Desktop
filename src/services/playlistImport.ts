import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { accountEpoch } from './accountScope'
import { commandErrorMessage, getVideoParts, inDesktopShell, searchBilibili, type MetadataPatch, type Playlist } from './desktopApi'
import { toTrack } from './collectionTrack'
import { chooseImportMatch, importKeyword, type ImportChoice, type ImportPlaylist, type ImportSong } from './playlistImportModel'
import { rankDurationFirstSongCandidates } from './externalSongMatch'
import type { Track } from '../domain/track'

export type ImportRow = { song: ImportSong; status:'pending'|'matched'|'missing'|'saved'; candidates:ImportChoice[]; chosen?:ImportChoice; message?:string }
export type ImportJob = { id:string; scope:string; name:string; source:string; rows:ImportRow[]; playlistId:string; state:'ready'|'matching'|'paused'|'waiting'|'saving'|'done'; message:string; retries:number }
export const usePlaylistImport = create<{job:ImportJob|null;scope:string}>(()=>({job:null,scope:''}))
let controller: AbortController | undefined
let booting: Promise<void> | undefined
let checkpointChain = Promise.resolve()
let lastSearch = 0
let runEpoch = 0
let activeWrites = 0
let searchGate = Promise.resolve()
let detailRequests = 0
const detailWaiters: (()=>void)[] = []
const MATCH_CONCURRENCY = 3

const abortError = () => new DOMException('Stopped','AbortError')
const delay = (ms:number,signal:AbortSignal) => new Promise<void>((resolve,reject)=>{
  if(signal.aborted) { reject(abortError()); return }
  const stop=()=>{clearTimeout(timer);reject(abortError())}
  const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve()},ms)
  signal.addEventListener('abort',stop,{once:true})
})
function database() {
  return new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('bilimusic-imports',1)
    request.onupgradeneeded=()=>request.result.createObjectStore('jobs')
    request.onsuccess=()=>resolve(request.result)
    request.onerror=()=>reject(request.error)
  })
}
function checkpoint(job:ImportJob) {
  // Persist the chosen result, not every search candidate or response body.
  const snapshot={...job,rows:job.rows.map(row=>({...row,candidates:[]}))}
  checkpointChain=checkpointChain.catch(()=>undefined).then(async()=>{
    const db=await database()
    try { await new Promise<void>((resolve,reject)=>{const tx=db.transaction('jobs','readwrite');tx.objectStore('jobs').put(snapshot,job.scope);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)}) }
    finally { db.close() }
  }).catch(()=>undefined)
}
function publish(job:ImportJob,persist=false) { usePlaylistImport.setState({job:{...job,rows:[...job.rows]}});if(persist)checkpoint(job) }
export async function bootPlaylistImport() {
  if(booting) { await booting;if(!usePlaylistImport.getState().scope)return bootPlaylistImport();return }
  const epoch=accountEpoch()
  booting=(async()=>{
    const scope=inDesktopShell?await invoke<string>('playlist_import_scope'):'browser-preview'
    if(epoch!==accountEpoch())return
    if(usePlaylistImport.getState().scope===scope)return
    pausePlaylistImport();usePlaylistImport.setState({scope,job:null})
    try {
      const db=await database()
      const saved=await new Promise<ImportJob|undefined>((resolve,reject)=>{const req=db.transaction('jobs').objectStore('jobs').get(scope);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})
      db.close()
      if(saved && saved.scope===scope && Array.isArray(saved.rows) && saved.rows.length<=5000 && epoch===accountEpoch()) {
        if(!['done','ready'].includes(saved.state))saved.state='paused'
        saved.message=saved.state==='paused'?'上次进度已保留，可以继续导入':saved.message
        publish(saved)
      }
    }catch{/* Progress remains available in memory when browser storage is unavailable. */}
  })().finally(()=>{booting=undefined})
  return booting
}
export function newPlaylistImport(playlist:ImportPlaylist,name:string) {
  pausePlaylistImport()
  const scope=usePlaylistImport.getState().scope
  if(!scope)throw new Error('导入页面尚未准备好，请重试')
  const id=crypto.randomUUID()
  const job:ImportJob={id,scope,name:name.trim().slice(0,80)||playlist.name.slice(0,80),source:playlist.source,playlistId:`import:${id}`,rows:playlist.songs.map(song=>({song,status:'pending',candidates:[]})),state:'ready',message:'',retries:0}
  publish(job,true)
}
export function pausePlaylistImport() {
  controller?.abort();controller=undefined;runEpoch++
  const job=usePlaylistImport.getState().job
  if(job && ['matching','waiting','saving'].includes(job.state))publish({...job,state:'paused',message:'已暂停，进度已保留'},true)
}
export function clearPlaylistImport() {
  pausePlaylistImport()
  const scope=usePlaylistImport.getState().scope
  usePlaylistImport.setState({job:null})
  checkpointChain=checkpointChain.catch(()=>undefined).then(async()=>{const db=await database();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('jobs','readwrite');tx.objectStore('jobs').delete(scope);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)});db.close()}).catch(()=>undefined)
}

export function makePlaylistReview(playlist:Playlist,tracks:Track[],scope:string):ImportJob {
  if(!playlist.id.startsWith('import:')||playlist.isSystem||playlist.biliFolderId)throw new Error('仅支持导入的本地歌单')
  return {id:`review:${playlist.id}`,scope,name:playlist.name,source:'text',playlistId:playlist.id,state:'done',message:'',retries:0,
    rows:tracks.map(track=>({status:'saved',candidates:[],song:{sourceId:track.id,title:track.title,artists:track.artist?.split(/\s*[/、;；]\s*/).filter(Boolean)||[],album:track.album,coverUrl:track.coverUrl,durationSeconds:track.durationSeconds},
      chosen:{track,evidence:{bvid:track.source.bvid,cid:track.source.cid,title:track.title,durationSeconds:track.durationSeconds,detailsVerified:true}}}))}
}

export async function replaceImportedPlaylistEntry(playlist:Playlist,original:Track,choice:ImportChoice,scope:string) {
  if(!playlist.id.startsWith('import:')||playlist.isSystem||playlist.biliFolderId)throw new Error('仅支持导入的本地歌单')
  const epoch=accountEpoch()
  await commitImportTracks(scope,playlist.id,playlist.name,[{track:choice.track,metadata:{title:original.title,artist:original.artist,album:original.album,coverUrl:original.coverUrl},replaceTrackId:original.id}])
  if(epoch!==accountEpoch())return
  const job=usePlaylistImport.getState().job
  if(job?.playlistId===playlist.id&&job.scope===scope) {
    for(const row of job.rows)if(row.status==='saved'&&row.chosen?.track.id===original.id){row.chosen=choice;row.candidates=[]}
    publish(job,true)
  }
}

function limited(error:unknown) {return /(?:412|429|-352|-509|-799)/.test(typeof error==='object'&&error&&'message'in error?String(error.message):String(error))}
async function search(keyword:string,signal:AbortSignal) {
  // Serialize dispatch times, not responses: a slow search must not stall every song.
  const turn=searchGate.catch(()=>undefined).then(async()=>{
    await delay(Math.max(0,1200-(Date.now()-lastSearch)),signal)
    if(signal.aborted)throw abortError()
    lastSearch=Date.now()
  })
  searchGate=turn.catch(()=>undefined)
  await turn
  if(signal.aborted)throw abortError()
  const result=await searchBilibili(keyword)
  if(signal.aborted)throw abortError()
  return result.items
}
async function videoDetail(bvid:string,signal:AbortSignal) {
  await new Promise<void>((resolve,reject)=>{
    if(signal.aborted){reject(abortError());return}
    const cancel=()=>{const i=detailWaiters.indexOf(start);if(i>=0)detailWaiters.splice(i,1);reject(abortError())}
    const start=()=>{signal.removeEventListener('abort',cancel);detailRequests++;resolve()}
    if(detailRequests<MATCH_CONCURRENCY)start()
    else{detailWaiters.push(start);signal.addEventListener('abort',cancel,{once:true})}
  })
  try{if(signal.aborted)throw abortError();return await getVideoParts(bvid)}
  finally{detailRequests--;detailWaiters.shift()?.()}
}
export async function findImportCandidates(song:ImportSong,signal:AbortSignal,manualKeyword?:string):Promise<ImportChoice[]> {
  const choices:ImportChoice[]=[],seen=new Set<string>()
  const queries=manualKeyword?[manualKeyword]:[importKeyword(song),importKeyword(song,true)]
  for(const keyword of [...new Set(queries)]) {
    const result=await search(keyword,signal)
    // Search duration is a coarse priority only; never import until actual parts are fetched.
    const provisional=rankDurationFirstSongCandidates(song,result.map(item=>({bvid:item.bvid,title:item.title,uploaderName:item.uploaderName,durationSeconds:item.durationSeconds,partCount:1,description:item.description})))
    const selected=provisional.ranked.slice(0,3).filter(item=>{if(seen.has(item.candidate.bvid))return false;seen.add(item.candidate.bvid);return true})
    const results=await Promise.allSettled(selected.map(async item=>{
      try {
        const detail=await videoDetail(item.candidate.bvid,signal)
        if(signal.aborted)throw abortError()
        return detail.parts.map(part=>{
          const track=toTrack(detail,part)
          return {track,evidence:{bvid:detail.bvid,cid:part.cid,title:track.title,videoTitle:detail.title,partTitle:part.title,
            description:result.find(row=>row.bvid===detail.bvid)?.description,uploaderName:detail.uploaderName,durationSeconds:part.durationSeconds,partCount:detail.parts.length,detailsVerified:true}}
        })
      }catch(error){
        const message=typeof error==='object'&&error&&'message'in error?String(error.message):String(error)
        if(signal.aborted||limited(error)||!/-404|-62002|不存在|已删除|不可见|无权限/.test(message))throw error
        return []
      }
    }))
    for(const response of results){if(response.status==='rejected')throw response.reason;choices.push(...response.value)}
    if(chooseImportMatch(song,choices))break
  }
  const ranked=rankDurationFirstSongCandidates(song,choices.map(choice=>choice.evidence)).ranked
  const ordered=ranked.slice(0,5).map(item=>choices.find(choice=>choice.track.source.bvid===item.candidate.bvid&&choice.track.source.cid===item.candidate.cid)!)
  const best=chooseImportMatch(song,choices)
  return best?[best,...ordered.filter(choice=>choice.track.id!==best.track.id)].slice(0,5):ordered
}

function toInput(track:Track) {return {id:track.id,bvid:track.source.bvid,aid:track.source.aid,cid:track.source.cid,page:track.source.page,sourceTitle:track.videoTitle||track.title,title:track.title,artist:track.artist,album:track.album,coverUrl:track.coverUrl,durationSeconds:track.durationSeconds,uploaderId:track.source.uploaderId,uploaderName:track.source.uploaderName}}
export async function commitImportTracks(scope:string,playlistId:string,name:string,entries:{track:Track;metadata?:MetadataPatch;replaceTrackId?:string}[]) {
  activeWrites++
  try {
    const playlist=await invoke<Playlist>('playlist_import_commit',{expectedScope:scope,playlistId,name,entries:entries.map(entry=>({...entry,track:toInput(entry.track)}))})
    window.dispatchEvent(new Event('bilimusic-data-changed'))
    window.dispatchEvent(new Event('bilimusic-import-updated'))
    return playlist
  }finally{activeWrites--}
}
async function saveMatched(job:ImportJob,signal:AbortSignal,epoch:number) {
  if(signal.aborted||epoch!==accountEpoch())throw abortError()
  // Only commit the completed prefix, even if later songs finish first.
  const pending=job.rows.findIndex(row=>row.status==='pending')
  const batch=job.rows.slice(0,pending<0?job.rows.length:pending).filter(row=>row.status==='matched'&&row.chosen).slice(0,100)
  if(!batch.length)return
  await commitImportTracks(job.scope,job.playlistId,job.name,batch.map(row=>({track:row.chosen!.track,metadata:{title:row.song.title,artist:row.song.artists.join(' / ')||undefined,album:row.song.album,coverUrl:row.song.coverUrl||row.chosen!.track.coverUrl}})))
  // A pause after the command was sent must still remember that this batch committed.
  if(epoch!==accountEpoch()||usePlaylistImport.getState().job?.id!==job.id)return
  batch.forEach(row=>{row.status='saved';row.candidates=[]})
  const current=usePlaylistImport.getState().job
  if(current?.id===job.id)publish(current,true)
}
export async function runPlaylistImport(retryMissing=false) {
  if(controller)return
  const job=usePlaylistImport.getState().job
  if(!job)return
  const own=++runEpoch,epoch=accountEpoch(),abort=new AbortController();controller=abort
  const signal=abort.signal
  if(retryMissing)job.rows.forEach(row=>{if(row.status==='missing')row.status='pending'})
  job.state='matching';job.message='正在匹配歌曲';publish(job,true)
  try {
    await saveMatched(job,signal,epoch)
    const pending=job.rows.filter(row=>row.status==='pending')
    let next=0,failure:unknown,failed=false,writes=Promise.resolve()
    const worker=async()=>{
      try{
        while(next<pending.length){
          if(signal.aborted||epoch!==accountEpoch())throw abortError()
          const row=pending[next++]
          job.message=`正在匹配「${row.song.title}」`;publish(job)
          const choices=await findImportCandidates(row.song,signal)
          if(signal.aborted||epoch!==accountEpoch())throw abortError()
          row.chosen=chooseImportMatch(row.song,choices);row.candidates=[]
          row.status=row.chosen?'matched':'missing'
          row.message=row.chosen?undefined:'暂未找到合适版本'
          job.retries=0
          publish(job)
          // Serialize writes while network requests from other workers continue.
          writes=writes.then(async()=>{
            if(!job.rows.some(row=>row.status==='saved')||job.rows.filter(row=>row.status==='matched').length>=10)
              await saveMatched(job,signal,epoch)
          })
          await writes
          if(job.rows.filter(row=>row.status!=='pending').length%10===0)checkpoint(job)
        }
      }catch(error){
        if(!signal.aborted){failed=true;failure=error;abort.abort()}
      }
    }
    await Promise.all(Array.from({length:Math.min(MATCH_CONCURRENCY,pending.length)},worker))
    if(failed)throw failure
    if(signal.aborted||epoch!==accountEpoch())throw abortError()
    job.state='saving';publish(job)
    while(job.rows.some(row=>row.status==='matched'))await saveMatched(job,signal,epoch)
    if(signal.aborted)throw abortError()
    job.state='done';job.message='导入完成';publish(job,true)
  }catch(error) {
    if(runEpoch===own&&epoch===accountEpoch()&&usePlaylistImport.getState().job?.id===job.id) {
      if(limited(error)&&job.retries<2){
        job.retries++;job.state='waiting';job.message='B 站请求较多，稍后自动继续';publish(job,true)
        const waiting=new AbortController();controller=waiting
        try{
          await delay(60_000*job.retries,waiting.signal)
          await restartAfterWait(job,own,epoch,waiting)
        }catch{/* A user pause/stop already published its state. */}
      }else{
        job.state='paused'
        job.message=limited(error)?'B 站暂时限制了搜索，进度已保留，请稍后继续':commandErrorMessage(error,'匹配暂时中断，进度已保留，请稍后继续')
        publish(job,true)
      }
    }
  }finally {if(runEpoch===own)controller=undefined}
}
async function restartAfterWait(job:ImportJob,own:number,epoch:number,abort:AbortController) {
  if(abort.signal.aborted||epoch!==accountEpoch()||runEpoch!==own)return
  controller=undefined
  publish({...job,state:'paused'})
  await runPlaylistImport()
}
export async function acceptImportCandidate(index:number,choice:ImportChoice) {
  const job=usePlaylistImport.getState().job
  if(!job || controller)throw new Error('请先暂停导入，再选择版本')
  if(activeWrites)throw new Error('正在保存歌曲，请稍后重试')
  const row=job.rows[index]
  if(!row)return
  const old=row.status==='saved'?row.chosen?.track.id:undefined
  const usedElsewhere=job.rows.some((other,i)=>i!==index&&other.status==='saved'&&other.chosen?.track.id===old)
  await commitImportTracks(job.scope,job.playlistId,job.name,[{track:choice.track,metadata:{title:row.song.title,artist:row.song.artists.join(' / ')||undefined,album:row.song.album,coverUrl:row.song.coverUrl||choice.track.coverUrl},replaceTrackId:usedElsewhere?undefined:old}])
  if(usePlaylistImport.getState().scope!==job.scope||usePlaylistImport.getState().job?.id!==job.id)return
  row.chosen=choice;row.status='saved';row.message=undefined
  row.candidates=[]
  publish(job,true)
}
window.addEventListener('bilimusic-account-changing',()=>{pausePlaylistImport();usePlaylistImport.setState({job:null,scope:''})})
