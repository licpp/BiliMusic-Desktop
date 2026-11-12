import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CalendarDays, ChartNoAxesColumn, Cloud, Headphones, Info, LoaderCircle, Music2, RefreshCw } from 'lucide-react'
import { getListeningStatistics, type ListeningPeriod } from '../../services/listeningStatistics'
import { commandErrorMessage } from '../../services/desktopApi'
import { MobilePage } from '../../shared/MobilePage'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { SegmentedTabs } from '../../shared/SegmentedTabs'
import { Artwork } from '../../shared/Artwork'
import { isMobile } from '../../services/platform'
import '../../styles/listening-statistics.css'
import { listeningCalendar } from './listeningCalendar'

const duration = (seconds: number) => seconds < 60 ? `${Math.floor(seconds)} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`
const bytes = (value: number) => value < 1048576 ? `${Math.round(value / 1024)} KB` : `${(value / 1048576).toFixed(1)} MB`
const tabs = [{ id: 'week', label: '本周' }, { id: 'month', label: '本月' }, { id: 'year', label: '本年' }, { id: 'total', label: '累计' }] as const
const labels = { week: '本周', month: '本月', year: '本年', total: '累计' }
const dayKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
const accountToday = () => new Date(`${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())}T00:00:00Z`)


function ListeningCalendar({ daily, year, today }: { daily: { day: string; seconds: number }[]; year: number; today: string }) {
  const cells = listeningCalendar(year, daily, today), scroll = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState(today)
  const current = cells.find(d => d.key === selected && !d.outside && !d.future)
  const fallback = cells.filter(d => !d.outside && !d.future).at(-1)?.key
  useEffect(() => { setSelected(year === Number(today.slice(0, 4)) ? today : `${year}-12-31`); if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth }, [year, today])
  return <>
    <div className="listening-calendar-scroll" ref={scroll}>
      <div className="listening-calendar-months" style={{ gridTemplateColumns: `repeat(${cells.length / 7}, 1fr)` }}>
        {cells.map((d, i) => !d.outside && d.date.getUTCDate() === 1 ? <span key={d.key} style={{ gridColumn: Math.floor(i / 7) + 1 }}>{d.date.getUTCMonth() + 1}月</span> : null)}
      </div>
      <div className="listening-calendar" role="group" aria-label={`${year}年每日聆听热力图，方向键选择日期`}>
        {cells.map((d, i) => <button key={d.key} type="button" data-day={d.key} data-level={d.level} data-outside={d.outside || undefined} data-future={d.future || undefined}
          disabled={d.outside || d.future} tabIndex={d.key === (current?.key || fallback) ? 0 : -1} aria-pressed={d.key === current?.key}
          aria-label={`${d.key}，${d.future ? '尚未到来' : d.seconds ? duration(d.seconds) : '没有聆听记录'}`} title={`${d.key} · ${duration(d.seconds)}`}
          onClick={() => setSelected(d.key)} onFocus={() => setSelected(d.key)}
          onKeyDown={e => {
            const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key]
            if (!step) return
            e.preventDefault()
            const target = cells[i + step]
            if (target && !target.outside && !target.future) e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-day="${target.key}"]`)?.focus()
          }} />)}
      </div>
    </div>
    <div className="listening-calendar-footer"><span aria-live="polite">{current ? `${current.date.getUTCMonth() + 1}月${current.date.getUTCDate()}日 · ${current.seconds ? duration(current.seconds) : '暂无记录'}` : '选择日期查看时长'}</span><div className="listening-calendar-legend" aria-label="颜色越深，聆听时间越长"><span>少</span>{[0, 1, 2, 3, 4].map(n => <i key={n} data-level={n} />)}<span>多</span></div></div>
  </>
}

export function ListeningStatistics({ onClose }: { onClose: () => void }) {
  const [period, setPeriod] = useState<ListeningPeriod>('week'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['listening-statistics'], queryFn: getListeningStatistics, refetchInterval: 15000 })
  useEffect(() => { window.dispatchEvent(new Event('bilimusic-statistics-sync-requested')) }, [])
  const data = query.data, summary = data?.[period], top = summary?.top
  const today = accountToday(), thisYear = today.getUTCFullYear(), todayKey = dayKey(today)
  const [calendarYear, setCalendarYear] = useState(thisYear)
  const years = [...new Set([thisYear, ...(data?.daily || []).map(d => Number(d.day.slice(0, 4)))])].sort((a, b) => b - a)
  const daily = new Map(data?.daily.map(d => [d.day, d.seconds]) || [])
  const start = new Date(today)
  if (period === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7)
  else start.setUTCDate(1)
  const barCount = period === 'week' ? 7 : new Date(Date.UTC(thisYear, today.getUTCMonth() + 1, 0)).getUTCDate()
  const bars = Array.from({ length: barCount }, (_, i) => {
    const date = new Date(start.getTime() + i * 86400000), key = dayKey(date)
    return { key, label: period === 'week' ? ['一', '二', '三', '四', '五', '六', '日'][i] : String(i + 1), seconds: daily.get(key) || 0, future: key > todayKey }
  })
  const max = Math.max(1, ...bars.map(d => d.seconds)), calendar = period === 'year' || period === 'total'
  const chartYear = period === 'year' ? thisYear : calendarYear
  const activeCalendarDays = data?.daily.filter(d => d.day.startsWith(String(chartYear)) && d.seconds > 0).length || 0
  const enabled = !!data?.sync.enabled
  const uid = data?.sync.uid
  const synchronize = async () => {
    setBusy(true); setError('')
    try { await invoke('listening_sync'); await client.invalidateQueries({ queryKey: ['listening-statistics'] }) }
    catch (e) { setError(commandErrorMessage(e)) }
    finally { setBusy(false) }
  }
  const configure = async () => {
    if (!uid) return
    setBusy(true); setError('')
    try {
      await invoke('listening_sync_configure', { uid, enabled: !enabled })
      await client.invalidateQueries({ queryKey: ['listening-statistics'] })
      window.dispatchEvent(new Event('bilimusic-statistics-sync-requested'))
    } catch (e) { setError(commandErrorMessage(e)) }
    finally { setBusy(false) }
  }
  const syncLabel = enabled ? data?.sync.error ? '账号统计 · 同步待重试' : data?.sync.pending ? '账号统计 · 有待上传记录' : data?.sync.lastSuccess ? '账号统计 · 已同步' : '账号统计 · 等待同步' : data?.sync.paused ? '账号统计同步已暂停' : uid ? '尚未连接统计同步服务' : '未登录 · 仅保存在本机'
  const body = <div className="listening-statistics">
    <SegmentedTabs tabs={tabs} value={period} onChange={setPeriod} idPrefix="statistics-period" panelId="statistics-panel" label="统计范围" className="listening-period" />
    {query.isLoading && <div className="listening-loading" role="status"><LoaderCircle className="spin" size={22} />正在整理聆听记录…</div>}
    {(query.error || error) && <p role="alert" className="inline-error">{error || commandErrorMessage(query.error)}</p>}
    {summary && <div id="statistics-panel" role="tabpanel" aria-labelledby={`statistics-period-${period}`}>
      <section className="listening-overview" aria-label={`${labels[period]}聆听总览`}>
        <div className="listening-overview-heading"><span className="listening-icon"><Headphones size={18} /></span><span>{labels[period]}聆听时长</span></div>
        <div className="listening-duration"><strong>{Math.floor(summary.seconds / (summary.seconds >= 3600 ? 3600 : 60)).toLocaleString()}</strong><span>{summary.seconds >= 3600 ? '小时' : '分钟'}</span>{summary.seconds >= 3600 && <><strong className="listening-duration-minutes">{Math.floor(summary.seconds % 3600 / 60)}</strong><span>分钟</span></>}</div>
        <div className="listening-metrics">
          <div><Music2 size={15} /><strong>{summary.tracks.toLocaleString()}</strong><span>首歌曲</span></div>
          <div><CalendarDays size={15} /><strong>{summary.days.toLocaleString()}</strong><span>天聆听</span></div>
          <div title="有效播放次数从新版开始记录"><Headphones size={15} /><strong>{summary.plays.toLocaleString()}</strong><span>次播放</span></div>
        </div>
      </section>
      <section className="listening-trend listening-section">
        <header><div><h3>{calendar ? '聆听日历' : '聆听足迹'}</h3><p>{calendar ? `${chartYear} 年，${activeCalendarDays} 天有音乐相伴` : period === 'week' ? '这一周，每天听了多久' : `${thisYear} 年 ${today.getUTCMonth() + 1} 月的每日时长`}</p></div>{period === 'total' ? <select aria-label="聆听日历年份" value={calendarYear} onChange={e => setCalendarYear(Number(e.target.value))}>{years.map(y => <option key={y} value={y}>{y} 年</option>)}</select> : <ChartNoAxesColumn size={18} aria-hidden="true" />}</header>
        {calendar ? <ListeningCalendar daily={data?.daily || []} year={chartYear} today={todayKey} /> : <>
          <div className="listening-chart-scale"><span>{duration(max === 1 ? 0 : max)}</span><span>0</span></div>
          <div className="listening-chart-scroll"><div className="listening-chart" style={{ '--bar-count': bars.length } as CSSProperties}>{bars.map((d, i) => <div key={d.key} data-today={d.key === todayKey || undefined} data-future={d.future || undefined} title={`${d.key} · ${duration(d.seconds)}`}><span style={{ height: `${d.seconds > 0 ? Math.max(3, d.seconds / max * 100) : 2}%` }} /><small>{period === 'week' || i === 0 || (i + 1) % 5 === 0 || i === bars.length - 1 ? d.label : ''}</small></div>)}</div></div>
        </>}
      </section>
      <section className="listening-section listening-favorites"><header><div><h3>常听的声音</h3><p>按聆听时长排序</p></div><span className="listening-count">{top?.length || 0} 首</span></header>
        {top?.length ? <ol className="listening-ranking">{top.map((track, i) => <li key={track.id}>
          <span className="listening-rank" data-leading={i < 3 || undefined}>{i + 1}</span><Artwork src={track.coverUrl} />
          <div className="listening-song"><strong>{track.title}</strong><small>{track.artist || '歌手未知'}</small><div className="listening-song-meter" aria-hidden="true"><span style={{ width: `${Math.max(2, track.seconds / Math.max(1, top[0].seconds) * 100)}%` }} /></div></div>
          <span className="listening-song-time">{duration(track.seconds)}</span>
        </li>)}</ol> : <div className="listening-empty"><Headphones size={30} /><strong>让喜欢的歌留下足迹</strong><p>开始播放后，这里会记录你常听的声音。</p></div>}
      </section>
      <div className="listening-sync"><Cloud size={17} /><div><strong>{syncLabel}</strong><small>{enabled && data?.sync.lastSuccess ? `上次同步 ${new Date(data.sync.lastSuccess).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : enabled ? `${data?.sync.provider === 'webdav' ? '坚果云' : 'BiliMusic 云'} · 汇总所有设备，约每 15 分钟自动同步` : data?.sync.paused ? '恢复后自动补传本机记录并合并其他设备统计' : '在云同步设置中连接服务，同账号各端使用同一服务和目录'}</small></div>{enabled && <button type="button" disabled={busy} onClick={() => void synchronize()} aria-label="同步听歌统计"><RefreshCw size={15} className={busy ? 'spin' : ''} />{busy ? '同步中' : '同步'}</button>}</div>
      {enabled && data?.sync.error && <p className="inline-error" role="status">{data.sync.error}</p>}
      <details className="listening-explanation"><summary><Info size={13} />统计说明</summary><p>按实际播放时长统计，日期统一采用 UTC+8。同一 B 站账号的各端连接同一同步服务后，共享一份统计；坚果云还需使用同一坚果云账号和目录。汇总所有设备的聆听时长，多端同时播放分别累计。离线记录在联网后补传，未登录时的本机记录不会自动归入账号。有效播放次数从新版开始记录，暂停恢复不重复计次。旧数据计入累计；历史月榜仅包含可还原的明细。</p>{enabled && <p>成功同步累计上传 {bytes(data?.sync.uploadedBytes || 0)}，下载 {bytes(data?.sync.downloadedBytes || 0)}，不含网络协议开销及失败周期。</p>}{uid && (data?.sync.provider || data?.sync.paused) && <button type="button" className="listening-sync-preference" disabled={busy} onClick={() => void configure()}>{enabled ? '暂停账号统计同步' : '恢复账号统计同步'}</button>}</details>
    </div>}
  </div>
  return isMobile ? <MobilePage className="listening-statistics-page" title="听歌统计" onBack={onClose}>{body}</MobilePage> : <CollectionDialog className="listening-statistics-dialog" title="听歌统计" onClose={onClose}>{body}</CollectionDialog>
}
