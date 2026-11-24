import { invoke } from '@tauri-apps/api/core'
import type { ImportedEntry, ImportedEntriesSnapshot } from '../domain/importedEntry'
import type { ImportChoice, ImportSong } from './playlistImportModel'
import type { Track } from '../domain/track'
import { accountEpoch } from './accountScope'
import { inDesktopShell } from './desktopApi'
import { sourceTrack } from '../domain/importedPresentation'
export type { ImportedEntry, ImportedEntriesSnapshot } from '../domain/importedEntry'
export type ImportBindingChange = {entryId:string; expectedRevision:string; track:Track; mode:'automatic'|'manual'}
const preview = new Map<string,ImportedEntry[]>()
const sessionExpired = () => Error('ACCOUNT_SESSION_EXPIRED')
const current = (epoch:number) => {if(epoch!==accountEpoch())throw sessionExpired()}
export function importTrackInput(track:Track) {
  track = sourceTrack(track)
  return {id:track.id,bvid:track.source.bvid,aid:track.source.aid,cid:track.source.cid,page:track.source.page,sourceTitle:track.videoTitle||track.title,sourceTitleContext:track.sourceTitleContext,title:track.title,artist:track.artist,album:track.album,coverUrl:track.coverUrl,durationSeconds:track.durationSeconds,uploaderId:track.source.uploaderId,uploaderName:track.source.uploaderName}
}
export async function importAccountSession() {
  const epoch=accountEpoch()
  const session=inDesktopShell?await invoke<string>('account_session'):`preview:${epoch}`
  current(epoch)
  return session
}
export async function loadImportedEntries(playlistId:string):Promise<ImportedEntriesSnapshot> {
  const epoch=accountEpoch()
  const snapshot=inDesktopShell?await invoke<ImportedEntriesSnapshot>('playlist_import_entries',{playlistId}):{session:`preview:${epoch}`,entries:preview.get(`${epoch}:${playlistId}`)||[]}
  current(epoch)
  return snapshot
}
export async function seedImportedEntries(playlistId:string,name:string,source:string,rows:{order:number;song:ImportSong}[],session?:string):Promise<ImportedEntriesSnapshot> {
  const epoch=accountEpoch(), expectedSession=session||await importAccountSession()
  current(epoch)
  let snapshot:ImportedEntriesSnapshot
  if(inDesktopShell)snapshot=await invoke<ImportedEntriesSnapshot>('playlist_import_seed',{expectedSession,playlistId,name,source,rows})
  else {
    if(expectedSession!==`preview:${epoch}`)throw sessionExpired()
    const key=`${epoch}:${playlistId}`
    const entries=preview.get(key)||rows.map(row=>({entryId:`${playlistId}:${row.order}`,playlistId,order:row.order,song:row.song,revision:'0'}))
    preview.set(key,entries);snapshot={session:expectedSession,entries}
  }
  current(epoch)
  return snapshot
}
export async function bindImportedEntries(playlistId:string,changes:ImportBindingChange[],session:string):Promise<ImportedEntriesSnapshot> {
  const epoch=accountEpoch()
  let snapshot:ImportedEntriesSnapshot
  if(inDesktopShell)snapshot=await invoke<ImportedEntriesSnapshot>('playlist_import_bind',{expectedSession:session,playlistId,changes:changes.map(c=>({...c,track:importTrackInput(c.track)}))})
  else {
    if(session!==`preview:${epoch}`)throw sessionExpired()
    const key=`${epoch}:${playlistId}`,before=preview.get(key)||[]
    const next=before.map(e=>({...e}))
    for(const c of changes){
      const entry=next.find(e=>e.entryId===c.entryId)
      if(!entry||entry.revision!==c.expectedRevision||c.mode==='automatic'&&entry.trackId)throw Error('导入条目已变化，请重试')
      if(next.some(e=>e.entryId!==entry.entryId&&e.trackId===c.track.id))throw Error('该视频已在歌单中，请选择其他视频')
      entry.trackId=c.track.id;entry.mode=c.mode;entry.revision=String(Number(entry.revision)+1)
    }
    preview.set(key,next);snapshot={session,entries:next}
  }
  current(epoch)
  window.dispatchEvent(new Event('bilimusic-data-changed'))
  window.dispatchEvent(new Event('bilimusic-import-updated'))
  return snapshot
}
export const replaceImportedEntry=(entry:ImportedEntry,choice:ImportChoice,session:string)=>bindImportedEntries(entry.playlistId,[{entryId:entry.entryId,expectedRevision:entry.revision,track:choice.track,mode:'manual'}],session)
export async function removeUnmatchedImportedEntry(entry: ImportedEntry, session: string): Promise<ImportedEntriesSnapshot> {
  const epoch = accountEpoch()
  const { playlistId, entryId, revision } = entry
  let snapshot: ImportedEntriesSnapshot
  if (inDesktopShell) {
    snapshot = await invoke('playlist_import_remove_missing', { expectedSession: session, playlistId, entryId, expectedRevision: revision })
  } else {
    if (session !== `preview:${epoch}`) throw sessionExpired()
    const key = `${epoch}:${playlistId}`
    const entries = preview.get(key) || []
    const currentEntry = entries.find(row => row.entryId === entryId)
    if (!currentEntry || currentEntry.trackId || currentEntry.revision !== revision) throw Error('这首歌已更新，请刷新后重试')
    snapshot = { session, entries: entries.filter(row => row.entryId !== entryId) }
    preview.set(key, snapshot.entries)
  }
  current(epoch)
  window.dispatchEvent(new Event('bilimusic-data-changed'))
  window.dispatchEvent(new Event('bilimusic-import-updated'))
  return snapshot
}
if(typeof window!=='undefined')window.addEventListener('bilimusic-account-changing',()=>preview.clear())
