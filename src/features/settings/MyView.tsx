import { useState } from 'react'
import { ChartNoAxesColumn } from 'lucide-react'
import { ListeningStatistics } from './ListeningStatistics'
import { AccountControl } from '../account/AccountControl'
import { SettingsView } from './SettingsView'
export function MyView() {
  const [statisticsOpen,setStatisticsOpen]=useState(false)
  return <section className="my-view"><header><span className="eyebrow">YOUR SPACE</span><h2>我的</h2></header><AccountControl expanded /><button className="mobile-row-action statistics-entry" onClick={()=>setStatisticsOpen(true)}><ChartNoAxesColumn size={20}/><span>听歌统计</span><span>›</span></button>{statisticsOpen&&<ListeningStatistics onClose={()=>setStatisticsOpen(false)}/>}<SettingsView embedded /></section>
}
