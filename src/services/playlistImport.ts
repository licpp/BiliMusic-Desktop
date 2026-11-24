import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { accountEpoch } from './accountScope'
import { commandErrorMessage, getVideoParts, inDesktopShell, listPlaylistTracks, searchBilibili } from './desktopApi'
import type { MetadataPatch, Playlist } from '../domain/library'
import { toTrack } from './collectionTrack'
import { chooseImportMatch, importKeyword, type ImportChoice, type ImportPlaylist, type ImportSong } from './playlistImportModel'
import { rankImportSongCandidates } from './externalSongMatch'
import type { Track } from '../domain/track'
import type { BiliSearchPage } from '../domain/bilibili'
import type { ImportedEntry, ImportedEntriesSnapshot } from '../domain/importedEntry'
import { loadImportedEntries, seedImportedEntries, bindImportedEntries, replaceImportedEntry, importTrackInput, importAccountSession } from './importedEntries'
import { ImportRequestPolicy, isImportRateLimit, isUnavailableImportCandidate, validImportBvid } from './playlistImportPolicy'
import { biliPauseMessage, biliRequestPause, type BiliPause } from './biliRequestStatus'

export type ImportRow = { entry?:ImportedEntry; order?:number; song: ImportSong; status:'pending'|'matched'|'missing'|'saved'; candidates:ImportChoice[]; chosen?:ImportChoice; message?:string }
export type ImportJob = { session?:string; id:string; scope:string; name:string; source:string; rows:ImportRow[]; playlistId:string; state:'ready'|'matching'|'paused'|'waiting'|'saving'|'done'; message:string; retries:number; retryAt?:number; biliPause?:BiliPause }
export const usePlaylistImport = create<{job:ImportJob|null;scope:string}>(()=>({job:null,scope:''}))
let controller: AbortController | undefined
let booting: Promise<void> | undefined
let checkpointChain = Promise.resolve()
const requestPolicy = new ImportRequestPolicy()
const searchCache = new Map<string,{expires:number;page:BiliSearchPage}>()
let runEpoch = 0
let reviewRequest = 0
let activeWrites = 0
const pendingCommits = new Set<Promise<Playlist>>()
let checkpointError: unknown
let searchGate = Promise.resolve()
let detailGate = Promise.resolve()
let detailRequests = 0
const detailWaiters: (()=>void)[] = []
const MATCH_CONCURRENCY = 2

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
function checkpoint(job:ImportJob,active=true) {
  // Persist the chosen result, not every search candidate or response body.
  const snapshot={...job,rows:job.rows.map(row=>({...row,candidates:[],chosen:row.chosen?{track:row.chosen.track,evidence:{bvid:row.chosen.track.source.bvid,cid:row.chosen.track.source.cid,title:row.chosen.track.title,detailsVerified:true}}:undefined}))}
  checkpointChain=checkpointChain.catch(()=>undefined).then(async()=>{
    // Canonical songs/bindings live in SQLite entries. Resume UI state is local
    // only, and must never write a stale archive over a cloud/manual choice.
    checkpointError=undefined
    try {const db=await database()
    try { await new Promise<void>((resolve,reject)=>{const tx=db.transaction('jobs','readwrite');if(active)tx.objectStore('jobs').put(snapshot,job.scope);tx.objectStore('jobs').put(snapshot,`${job.scope}:playlist:${job.playlistId}`);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)}) }
    finally { db.close() }}catch(error){if(!inDesktopShell)throw error}
  }).catch(error=>{checkpointError=error})
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
        saved.rows.forEach((row,index)=>{row.order??=index})
        if(!saved.biliPause)requestPolicy.restore(saved.retryAt,saved.retries)
        if(!['done','ready'].includes(saved.state))saved.state='paused'
        if(saved.state==='paused')saved.message=saved.biliPause?biliPauseMessage(saved.biliPause):'上次进度已保留，可以继续导入'
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
  const job:ImportJob={id,scope,name:name.trim().slice(0,80)||playlist.name.slice(0,80),source:playlist.source,playlistId:`import:${id}`,rows:playlist.songs.map((song,order)=>({song,order,status:'pending',candidates:[]})),state:'ready',message:'',retries:0}
  publish(job,true)
}
export function pausePlaylistImport() {
  controller?.abort();controller=undefined;runEpoch++;reviewRequest++
  const job=usePlaylistImport.getState().job
  if(job && ['matching','waiting','saving'].includes(job.state))publish({...job,state:'paused',message:'已暂停，进度已保留'},true)
}
export function clearPlaylistImport() {
  pausePlaylistImport()
  const scope=usePlaylistImport.getState().scope
  usePlaylistImport.setState({job:null})
  checkpointChain=checkpointChain.catch(()=>undefined).then(async()=>{const db=await database();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('jobs','readwrite');tx.objectStore('jobs').delete(scope);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)});db.close()}).catch(()=>undefined)
}


export async function replaceImportedPlaylistEntry(playlist:Playlist,original:Track,choice:ImportChoice,_scope:string) {
  const snapshot=await loadImportedEntries(playlist.id)
  const entry=snapshot.entries.find(e=>e.trackId===original.id)
  if(!entry)throw Error('这首歌不是外部歌单匹配条目')
  await replaceImportedEntry(entry,choice,snapshot.session)
}

const limited = isImportRateLimit
async function search(keyword:string,signal:AbortSignal,interactive=false,page=1) {
  const epoch=accountEpoch(),key=`${epoch}:${page}:${keyword.trim()}`
  const cached=searchCache.get(key)
  if(cached && cached.expires>Date.now()){if(signal.aborted)throw abortError();return cached.page}
  if(interactive && requestPolicy.blockedUntil>Date.now())throw new Error('B 站暂时限制了搜索，请稍后再查找')
  // Serialize dispatch times, not responses: a slow search must not stall every song.
  const turn=searchGate.catch(()=>undefined).then(async()=>{
    while(requestPolicy.searchWait()>0){
      if(interactive && requestPolicy.blockedUntil>Date.now())throw new Error('B 站暂时限制了搜索，请稍后再查找')
      await delay(requestPolicy.searchWait(),signal)
    }
    if(signal.aborted||epoch!==accountEpoch())throw abortError()
    requestPolicy.searched()
  })
  searchGate=turn.catch(()=>undefined)
  await turn
  if(signal.aborted)throw abortError()
  const shared=searchCache.get(key)
  if(shared && shared.expires>Date.now())return shared.page
  try {
    const raw=await searchBilibili(keyword,page)
    const result={...raw,page:raw.page||page,pageSize:raw.pageSize||20,total:raw.total??raw.items.length}
    if(signal.aborted||epoch!==accountEpoch())throw abortError()
    searchCache.set(key,{expires:Date.now()+(result.items.length?600_000:60_000),page:result})
    while(searchCache.size>100)searchCache.delete(searchCache.keys().next().value!)
    return result
  }catch(error){if(epoch===accountEpoch()&&!biliRequestPause(error)&&limited(error))requestPolicy.restricted();throw error}
}
async function videoDetail(bvid:string,signal:AbortSignal) {
  await new Promise<void>((resolve,reject)=>{
    if(signal.aborted){reject(abortError());return}
    const cancel=()=>{const i=detailWaiters.indexOf(start);if(i>=0)detailWaiters.splice(i,1);reject(abortError())}
    const start=()=>{signal.removeEventListener('abort',cancel);detailRequests++;resolve()}
    if(detailRequests<MATCH_CONCURRENCY)start()
    else{detailWaiters.push(start);signal.addEventListener('abort',cancel,{once:true})}
  })
  const epoch=accountEpoch()
  try{
    const turn=detailGate.catch(()=>undefined).then(async()=>{
      while(requestPolicy.detailWait()>0)await delay(requestPolicy.detailWait(),signal)
      if(signal.aborted||epoch!==accountEpoch())throw abortError()
      requestPolicy.detailed()
    })
    detailGate=turn.catch(()=>undefined);await turn
    const detail=await getVideoParts(bvid)
    if(signal.aborted||epoch!==accountEpoch())throw abortError()
    return detail
  }catch(error){if(epoch===accountEpoch()&&!biliRequestPause(error)&&limited(error))requestPolicy.restricted();throw error}
  finally{detailRequests--;detailWaiters.shift()?.()}
}
/** User searches are ordinary Bilibili searches, never filtered by the song. */
export async function searchReplacementVideos(query:string,page=1,signal:AbortSignal):Promise<BiliSearchPage> {
  if(signal.aborted)throw abortError()
  const term=query.trim()
  if(!term)return {items:[],page,pageSize:20,total:0}
  const direct=term.match(/(?:^|\/)(BV[A-Za-z0-9]{10})(?:[/?#]|$)/)?.[1]
  if(direct && page===1){
    const detail=await videoDetail(direct,signal)
    if(detail.bvid!==direct)throw {code:'bili_invalid_candidate',message:'视频详情与请求不符'}
    return {page:1,pageSize:20,total:1,items:[{bvid:direct,title:detail.title,uploaderName:detail.uploaderName,uploaderId:detail.uploaderId,coverUrl:detail.coverUrl,durationSeconds:detail.parts.reduce((n,p)=>n+p.durationSeconds,0),playCount:detail.playCount||0,description:'',publishedAt:detail.publishedAt}]}
  }
  const result=await search(term,signal,true,page)
  return {...result,items:result.items.filter(item=>validImportBvid(item.bvid))}
}
export async function resolveReplacementVideo(bvid:string,signal:AbortSignal):Promise<ImportChoice[]> {
  if(!validImportBvid(bvid))throw Error('无效的 BV 号')
  const detail=await videoDetail(bvid,signal)
  if(detail.bvid!==bvid)throw {code:'bili_invalid_candidate',message:'视频详情与请求不符'}
  return detail.parts.filter(part=>Number.isSafeInteger(part.cid)&&part.cid>0).map(part=>({track:toTrack(detail,part),evidence:{bvid,cid:part.cid,title:detail.parts.length>1?part.title:detail.title,videoTitle:detail.title,partTitle:part.title,uploaderName:detail.uploaderName,durationSeconds:part.durationSeconds,partCount:detail.parts.length,detailsVerified:true,playCount:detail.playCount}}))
}
export async function findImportCandidates(song:ImportSong,signal:AbortSignal,manualKeyword?:string):Promise<ImportChoice[]> {
  if(manualKeyword){
    // Compatibility helper for older callers. New views render the paginated
    // search page and only resolve the video the user opens or chooses.
    const result=await searchReplacementVideos(manualKeyword,1,signal),choices:ImportChoice[]=[]
    for(const item of result.items.slice(0,3))choices.push(...await resolveReplacementVideo(item.bvid,signal))
    return choices
  }
  const choices:ImportChoice[]=[],seen=new Set<string>()
  for(const keyword of [...new Set([importKeyword(song),importKeyword(song,true)])]) {
    const {items}=await search(keyword,signal)
    const provisional=rankImportSongCandidates(song,items.filter(item=>validImportBvid(item.bvid)).map(item=>({bvid:item.bvid,title:item.title,uploaderName:item.uploaderName,durationSeconds:item.durationSeconds,description:item.description,playCount:item.playCount})))
    const selected=provisional.ranked.filter(item=>!item.versionConflict).slice(0,5)
    let inspected=0
    for(const item of selected){
      const bvid=item.candidate.bvid
      if(seen.has(bvid))continue
      seen.add(bvid)
      inspected++
      try {
        const resolved=await resolveReplacementVideo(bvid,signal)
        const description=items.find(row=>row.bvid===bvid)?.description
        choices.push(...resolved.map(choice=>({...choice,evidence:{...choice.evidence,description,playCount:choice.evidence.playCount??item.candidate.playCount}})))
      }catch(error){
        if(signal.aborted||limited(error)||!isUnavailableImportCandidate(error))throw error
      }
      // Compare a bounded shortlist instead of accepting the first merely
      // playable upload. Only inspect the remaining two if none is usable.
      if(inspected>=3 && chooseImportMatch(song,choices))break
    }
    const best=chooseImportMatch(song,choices)
    // A sparse first query can hide popular results behind a singer spelling.
    // Reuse the existing title-only fallback for cold/unknown results as well.
    if(best && (best.evidence.playCount || 0)>=10_000)return [best]
  }
  const best=chooseImportMatch(song,choices)
  return best?[best]:[]
}

function reviewFromEntries(playlist:Playlist,tracks:Track[],scope:string,snapshot:ImportedEntriesSnapshot):ImportJob {
  const available=new Map(tracks.map(t=>[t.id,t]))
  return {id:`review:${playlist.id}`,scope,session:snapshot.session,name:playlist.name,source:'text',playlistId:playlist.id,state:'done',message:'',retries:0,
    rows:[...snapshot.entries].sort((a,b)=>a.order-b.order||a.entryId.localeCompare(b.entryId)).map(entry=>{
      const track=entry.trackId?available.get(entry.trackId):undefined
      return {entry,order:entry.order,song:entry.song,message:entry.message,status:entry.trackId?'saved':'missing',candidates:[],chosen:track?{track,evidence:{bvid:track.source.bvid,cid:track.source.cid,title:track.title,detailsVerified:true,partCount:track.partCount,durationSeconds:track.durationSeconds}}:undefined}
    })}
}
export async function loadPlaylistReview(playlist:Playlist,tracks:Track[],scope:string):Promise<ImportJob> {
  const epoch=accountEpoch(),active=usePlaylistImport.getState().job
  if(active?.playlistId===playlist.id && active.scope===scope && ['matching','saving','waiting'].includes(active.state))pausePlaylistImport()
  if(pendingCommits.size){await Promise.allSettled([...pendingCommits]);tracks=await listPlaylistTracks(playlist.id)}
  const snapshot=await loadImportedEntries(playlist.id)
  if(epoch!==accountEpoch())throw abortError()
  return reviewFromEntries(playlist,tracks,scope,snapshot)
}
export async function acceptReviewCandidate(job:ImportJob,index:number,choice:ImportChoice) {
  const row=job.rows[index]
  if(!row?.entry||!job.session)throw Error('导入条目已变化，请重新打开')
  const epoch=accountEpoch()
  const snapshot=await replaceImportedEntry(row.entry,choice,job.session)
  if(epoch!==accountEpoch())return job
  const entries=new Map(snapshot.entries.map(e=>[e.entryId,e]))
  const next={...job,session:snapshot.session,rows:job.rows.map(value=>{
    const entry=value.entry&&entries.get(value.entry.entryId)
    if(!entry)return value
    return {...value,entry,status:entry.trackId?'saved' as const:'missing' as const,chosen:entry.trackId===choice.track.id?choice:value.chosen,candidates:[]}
  })}
  const active=usePlaylistImport.getState().job
  if(active?.playlistId===next.playlistId&&active.scope===next.scope)publish({...next,id:active.id,state:active.state==='done'?'done':'paused'},true)
  await checkpointChain
  return next
}
async function prepareEntries(job:ImportJob,signal?:AbortSignal) {
  const epoch=accountEpoch()
  const valid=()=>{if(signal?.aborted||epoch!==accountEpoch())throw abortError()}
  valid()
  let snapshot=await loadImportedEntries(job.playlistId)
  valid()
  if(!snapshot.entries.length && job.session)throw Error('歌单已删除或导入条目已移除')
  if(!snapshot.entries.length)snapshot=await seedImportedEntries(job.playlistId,job.name,job.source,job.rows.map((row,i)=>({order:row.order??i,song:row.song})),snapshot.session)
  if(epoch!==accountEpoch())throw abortError()
  job.session=snapshot.session
  const byId=new Map(job.rows.filter(row=>row.entry).map(row=>[row.entry!.entryId,row]))
  const byOrder=new Map(job.rows.map((row,i)=>[row.order??i,row]))
  job.rows=[...snapshot.entries].sort((a,b)=>a.order-b.order).map(entry=>{
    const old=byId.get(entry.entryId)||byOrder.get(entry.order)
    if(!old)return {entry,order:entry.order,song:entry.song,status:entry.trackId?'saved':'missing',candidates:[]}
    const row:ImportRow={...old,entry,order:entry.order,song:entry.song}
    if(entry.trackId){row.status='saved';if(row.chosen?.track.id!==entry.trackId)row.chosen=undefined}
    else if(row.status==='saved'){row.status='pending';row.chosen=undefined}
    return row
  })
}
export async function retryMissingImportedPlaylist(playlist:Playlist,entryId?:string):Promise<void> {
  const epoch=accountEpoch()
  await bootPlaylistImport()
  if(epoch!==accountEpoch())throw abortError()
  pausePlaylistImport()
  const request=++reviewRequest
  const valid=()=>{if(epoch!==accountEpoch()||request!==reviewRequest)throw abortError()}
  const tracks=await listPlaylistTracks(playlist.id)
  valid()
  const snapshot=await loadImportedEntries(playlist.id)
  valid()
  const scope=usePlaylistImport.getState().scope
  const job=reviewFromEntries(playlist,tracks,scope,snapshot)
  job.id=`retry:${playlist.id}:${crypto.randomUUID()}`
  for(const row of job.rows)if(!row.entry?.trackId&&(!entryId||row.entry?.entryId===entryId))row.status='pending'
  if(!job.rows.some(row=>row.status==='pending'))return
  publish(job,true)
  await runPlaylistImport()
}


export async function commitImportTracks(scope:string,playlistId:string,name:string,entries:{track:Track;metadata?:MetadataPatch;replaceTrackId?:string;originalPosition?:number}[]) {
  const epoch=accountEpoch(),expectedAccountSession=await importAccountSession()
  if(epoch!==accountEpoch())throw abortError()
  activeWrites++
  let request:Promise<Playlist>|undefined
  try {
    request=invoke<Playlist>('playlist_import_commit',{expectedScope:scope,expectedAccountSession,playlistId,name,entries:entries.map(entry=>({...entry,track:importTrackInput(entry.track)}))})
    pendingCommits.add(request)
    const playlist=await request
    if(epoch!==accountEpoch())throw abortError()
    window.dispatchEvent(new Event('bilimusic-data-changed'))
    window.dispatchEvent(new Event('bilimusic-import-updated'))
    return playlist
  }finally{activeWrites--;if(request)pendingCommits.delete(request)}
}
async function saveMatched(job:ImportJob,signal:AbortSignal,epoch:number) {
  if(signal.aborted||epoch!==accountEpoch())throw abortError()
  // Only commit the completed prefix, even if later songs finish first.
  const pending=job.rows.findIndex(row=>row.status==='pending')
  const completed=job.rows.slice(0,pending<0?job.rows.length:pending).filter(row=>row.status==='matched'&&row.chosen).slice(0,100)
  const used=new Set(job.rows.filter(row=>row.status==='saved').map(row=>row.entry?.trackId||row.chosen?.track.id).filter(Boolean))
  const batch=completed.filter(row=>{
    const id=row.chosen!.track.id
    if(used.has(id)){row.status='missing';row.chosen=undefined;row.message='该视频已被歌单中另一首歌曲使用';return false}
    used.add(id);return true
  })
  if(!batch.length)return
  await checkpointChain
  if(checkpointError)throw checkpointError
  if(signal.aborted||epoch!==accountEpoch())throw abortError()
  if(!job.session||batch.some(row=>!row.entry))throw Error('导入条目尚未准备好')
  const request=bindImportedEntries(job.playlistId,batch.map(row=>({entryId:row.entry!.entryId,expectedRevision:row.entry!.revision,track:row.chosen!.track,mode:'automatic'})),job.session)
  activeWrites++
  // Keep review reads behind the same in-flight barrier as legacy imports.
  const barrier=request.then(()=>({id:job.playlistId} as Playlist));void barrier.catch(()=>undefined);pendingCommits.add(barrier)
  let snapshot:ImportedEntriesSnapshot
  try{snapshot=await request}finally{activeWrites--;pendingCommits.delete(barrier)}
  for(const row of job.rows){const entry=snapshot.entries.find(e=>e.entryId===row.entry?.entryId);if(entry)row.entry=entry}
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
  requestPolicy.restore(job.retryAt,job.retries)
  if(requestPolicy.blockedUntil>Date.now())job.retryAt=Math.max(job.retryAt||0,requestPolicy.blockedUntil)
  if(retryMissing)job.rows.forEach(row=>{if(row.status==='missing')row.status='pending'})
  job.state='matching';job.message='正在匹配歌曲';publish(job,true)
  try {
    if(job.biliPause) {
      if(job.retryAt && job.retryAt>Date.now()) {
        job.state='paused';job.message=biliPauseMessage(job.biliPause);publish(job,true)
        return
      }
      job.biliPause=undefined;job.retryAt=undefined
    }
    if(job.retryAt && job.retryAt>Date.now()){
      job.state='waiting';job.message='B 站暂时限制了搜索，等待后继续';publish(job,true)
      while(job.retryAt>Date.now())await delay(job.retryAt-Date.now(),signal)
      job.state='matching';job.message='正在匹配歌曲';publish(job,true)
    }
    await prepareEntries(job,signal)
    if(signal.aborted||epoch!==accountEpoch()||usePlaylistImport.getState().job?.id!==job.id)throw abortError()
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
      const pause=biliRequestPause(error)
      if(pause) {
        job.biliPause=pause;job.retryAt=pause.retryAt;job.state='paused';job.message=biliPauseMessage(pause);publish(job,true)
        return
      }
      if(limited(error))job.retryAt=requestPolicy.restricted(job.retries)
      if(limited(error)&&job.retries<2){
        job.retries++;job.state='waiting';job.message='B 站请求较多，稍后自动继续';publish(job,true)
        const waiting=new AbortController();controller=waiting
        try{
          while(job.retryAt!>Date.now())await delay(job.retryAt!-Date.now(),waiting.signal)
          await restartAfterWait(job,own,epoch,waiting)
        }catch{/* A user pause/stop already published its state. */}
      }else{
        const conflict=/stale|revision|条目已变化|版本已变化|已在歌单中|已更新|已匹配|已移除/i.test(commandErrorMessage(error))
        if(conflict){
          try{await prepareEntries(job)}catch{/* Preserve the interrupted task; never replace canonical data with stale results. */}
        }
        if(epoch!==accountEpoch()||usePlaylistImport.getState().job?.id!==job.id)return
        job.state='paused'
        job.message=limited(error)?'B 站暂时限制了搜索，进度已保留，请稍后继续':conflict?'歌单已更新，已保留最新选择，可以继续匹配':commandErrorMessage(error,'匹配暂时中断，进度已保留，请稍后继续')
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
  if(!job||controller)throw Error('请先暂停导入，再选择版本')
  if(activeWrites)throw Error('正在保存歌曲，请稍后重试')
  if(!job.rows[index]?.entry)await prepareEntries(job)
  await acceptReviewCandidate(job,index,choice)
}

window.addEventListener('bilimusic-account-changing',()=>{pausePlaylistImport();searchCache.clear();requestPolicy.reset();usePlaylistImport.setState({job:null,scope:''})})
