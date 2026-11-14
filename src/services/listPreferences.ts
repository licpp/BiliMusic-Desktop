import {useQuery,useQueryClient} from '@tanstack/react-query'
import {invoke} from '@tauri-apps/api/core'
import {inDesktopShell} from './desktopApi'
import {accountEpoch} from './accountScope'
import type {ListPreference,ListPreferences} from './listOrdering'
export const playlistEntity=(playlist:{id:string;biliFolderId?:number})=>playlist.id==='system:favorites'?'view:favorites':playlist.biliFolderId?`linkedFolder:${playlist.biliFolderId}`:`playlist:${playlist.id}`
export function useListPreferences(){return useQuery({queryKey:['list-preferences',accountEpoch()],queryFn:()=>inDesktopShell?invoke<ListPreferences>('list_preferences'):Promise.resolve({preferences:[],dates:{}}),staleTime:30_000})}
export function useSaveListPreferences(){const client=useQueryClient();return async(changes:ListPreference[])=>{
 const epoch=accountEpoch();if(inDesktopShell)await invoke('list_preferences_save',{changes})
 if(epoch!==accountEpoch())throw Error('账号已切换，请重新打开列表')
 client.setQueryData<ListPreferences>(['list-preferences',epoch],previous=>({dates:previous?.dates||{},preferences:[...(previous?.preferences||[]).filter(p=>!changes.some(row=>row.entity===p.entity)),...changes.map(row=>({...previous?.preferences.find(p=>p.entity===row.entity),...row}))]}))
 window.dispatchEvent(new Event('bilimusic-data-changed'))
}}
