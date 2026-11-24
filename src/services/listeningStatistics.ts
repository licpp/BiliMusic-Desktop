import { contentTitle, type SourceTitleContext } from '../domain/sourceTitle'
import { invoke } from '@tauri-apps/api/core'
export type ListeningPeriod = 'week' | 'month' | 'year' | 'total'
type ListeningSummary = {seconds:number; tracks:number; days:number; plays:number; top:ListeningRank[]}
type PreferenceItem = {id:string; label:string; seconds:number}
export type ListeningPreferences = { artists: PreferenceItem[]; uploaders: PreferenceItem[]; themes: PreferenceItem[]; artistSeconds: number; uploaderSeconds: number; themeSeconds: number }
export type ListeningStatistics = Record<ListeningPeriod,ListeningSummary> & {preferences?:ListeningPreferences; daily:{day:string;seconds:number}[]; timezone:string; sync:{uid:string;provider:'cloud'|'webdav'|null;paused:boolean;enabled:boolean;lastSuccess?:string;error?:string;pending:number;uploadedBytes:number;downloadedBytes:number}}
type ListeningRank = {id:string;title:string;artist:string;coverUrl:string;seconds:number;titleOverridden?:boolean;sourceTitleContext?:SourceTitleContext;uploaderName?:string}
export const getListeningStatistics = async () => {
  const report = await invoke<ListeningStatistics>('listening_statistics')
  for (const period of ['week','month','year','total'] as const) report[period] = {...report[period],top:report[period].top.map(item=>({...item,title:!item.titleOverridden && item.sourceTitleContext ? contentTitle(item.sourceTitleContext) : item.title}))}
  return report
}
