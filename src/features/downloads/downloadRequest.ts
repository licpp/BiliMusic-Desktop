import { create } from 'zustand'
import type { Track } from '../../domain/track'
export type DownloadOptions = { audioId:number; exportFormat:'auto'|'original'|'flac'; directory?:string; skipExisting?:boolean }
export const useDownloadRequest=create<{request:{tracks:Track[];directory?:string}|null}>(()=>({request:null}))
export function chooseDownload(tracks:Track[],directory?:string){const items=[...new Map(tracks.filter(track=>track.source.provider==='bilibili').map(track=>[track.id,track])).values()];if(items.length)useDownloadRequest.setState({request:{tracks:items,directory}})}
window.addEventListener('bilimusic-account-changing',()=>useDownloadRequest.setState({request:null}))
