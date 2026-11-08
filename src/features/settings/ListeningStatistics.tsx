import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { getListeningStatistics } from '../../services/listeningStatistics'
import { commandErrorMessage } from '../../services/desktopApi'
import { MobilePage } from '../../shared/MobilePage'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { Artwork } from '../../shared/Artwork'
import { isMobile } from '../../services/platform'
const duration=(seconds:number)=>seconds<60?`${Math.floor(seconds)} 秒`:seconds<3600?`${Math.floor(seconds/60)} 分钟`:`${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分钟`
export function ListeningStatistics({onClose}:{onClose:()=>void}){
  const [period,setPeriod]=useState<'week'|'total'>('week')
  const query=useQuery({queryKey:['listening-statistics'],queryFn:getListeningStatistics,refetchInterval:10000})
  const data=query.data,summary=data?.[period],top=period==='week'?data?.weekTop:data?.totalTop
  const monday=new Date();monday.setDate(monday.getDate()-(monday.getDay()+6)%7)
  const days=Array.from({length:7},(_,i)=>{const d=new Date(monday);d.setDate(d.getDate()+i);const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;return {label:['一','二','三','四','五','六','日'][i],seconds:data?.daily.find(x=>x.day===key)?.seconds||0}})
  const max=Math.max(1,...days.map(d=>d.seconds))
  const body=<div className="listening-statistics"><div className="listening-period" role="tablist" aria-label="统计范围"><button role="tab" aria-selected={period==='week'} onClick={()=>setPeriod('week')}>本周</button><button role="tab" aria-selected={period==='total'} onClick={()=>setPeriod('total')}>累计</button></div>
    {query.isLoading&&<p>正在读取统计…</p>}{query.error&&<p role="alert" className="inline-error">{commandErrorMessage(query.error)}</p>}
    {summary&&<><div className="listening-summary"><strong>{duration(summary.seconds)}</strong><span>听过 {summary.tracks} 首 · 聆听 {summary.days} 天</span></div><h3>本周聆听</h3><div className="listening-chart">{days.map(d=><div key={d.label} title={`周${d.label} · ${duration(d.seconds)}`}><span style={{height:`${Math.max(d.seconds>0?3:0,d.seconds/max*100)}%`}}/><small>{d.label}</small></div>)}</div><h3>常听的声音</h3><div className="listening-ranking">{top?.map((track,i)=><div key={track.id}><span>{i+1}</span><Artwork src={track.coverUrl}/><div><strong>{track.title}</strong><small>{track.artist||'歌手未知'}</small></div><small>{duration(track.seconds)}</small></div>)}{!top?.length&&<p className="mobile-page-empty">开始聆听后，这里会留下记录</p>}</div><p className="statistics-note">从此版本开始记录，统计保存在本机。</p></>}
  </div>
  return isMobile?<MobilePage title="听歌统计" onBack={onClose}>{body}</MobilePage>:<CollectionDialog title="听歌统计" onClose={onClose}>{body}</CollectionDialog>
}
