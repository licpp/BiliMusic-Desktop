import { useState } from 'react'
import { ChartNoAxesColumn, ChevronRight } from 'lucide-react'
import { ListeningStatistics } from './ListeningStatistics'
import { AccountControl } from '../account/AccountControl'
import { SettingsView } from './SettingsView'
export function MyView({ onOpenDownloads }: { onOpenDownloads: () => void }) {
  const [statisticsOpen,setStatisticsOpen]=useState(false)
  return <section className="my-view"><AccountControl expanded /><button className="statistics-entry settings-statistics-entry" onClick={()=>setStatisticsOpen(true)}><span className="settings-icon"><ChartNoAxesColumn size={20}/></span><span className="statistics-entry-copy"><strong>听歌统计</strong><small>查看聆听时长、常听歌曲与聆听日历</small></span><ChevronRight size={18}/></button>{statisticsOpen&&<ListeningStatistics onClose={()=>setStatisticsOpen(false)}/>}<SettingsView embedded onOpenDownloads={onOpenDownloads}/></section>
}
