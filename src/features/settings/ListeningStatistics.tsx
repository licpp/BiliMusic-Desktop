import { accountQueryKey } from '../../services/queryKeys'
import { accountEpoch } from '../../services/accountScope'
import { reportSyncError } from '../../services/syncAttention'
import { trackSubtitle } from '../../domain/sourceTitle'
import { syncErrorMessage } from '../../services/userErrors'
import { ListeningBars } from './ListeningBars'
import { hydrateSourceTitles } from '../player/sourceTitles'
import { listeningDuration, listeningTimeParts } from '../../shared/listeningDuration'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CalendarDays, ChartNoAxesColumn, Cloud, Headphones, Info, Music2, RefreshCw } from 'lucide-react'
import { ListSkeleton } from '../../shared/ListSkeleton'
import { useListDataDuringNavigation, useListReveal } from '../../shared/useListMotion'
import { getListeningStatistics, type ListeningPeriod, type ListeningPreferences } from '../../services/listeningStatistics'
import { commandErrorMessage } from '../../services/desktopApi'
import { MobilePage } from '../../shared/MobilePage'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { SwipeTabPages } from '../../shared/SwipeTabPages'
import { ListeningArtwork } from './ListeningArtwork'
import { isMobile } from '../../services/platform'
import '../../styles/listening-statistics.css'
import { listeningCalendar } from './listeningCalendar'

const duration = listeningDuration
const bytes = (value: number) => value < 1048576 ? `${Math.round(value / 1024)} KB` : `${(value / 1048576).toFixed(1)} MB`
const tabs = [{ id: 'week', label: '本周' }, { id: 'month', label: '本月' }, { id: 'year', label: '本年' }, { id: 'total', label: '累计' }] as const
const labels = { week: '本周', month: '本月', year: '本年', total: '累计' }
const dayKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
const accountToday = () => new Date(`${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())}T00:00:00Z`)

const preferenceKinds = { artists: '歌手', uploaders: 'UP 主', themes: '关键词' } as const
type PreferenceKind = keyof typeof preferenceKinds
function PreferenceSummary({ preferences }: { preferences?: ListeningPreferences }) {
  const [kindFilter, setKindFilter] = useState<'all' | PreferenceKind>('all')
  const [picked, setPicked] = useState<string>()
  const groups = Object.keys(preferenceKinds) as PreferenceKind[]
  const availableKinds = groups.filter(kind => (preferences?.[kind]?.length || 0) > 0)
  const activeFilter: 'all' | PreferenceKind = kindFilter !== 'all' && !availableKinds.includes(kindFilter) ? 'all' : kindFilter
  const allItems = groups.flatMap(kind => (preferences?.[kind] || []).slice(0, 8).map(item => ({
    ...item, kind, key: `${kind}:${item.id}`,
  }))).sort((a, b) => b.seconds - a.seconds)
  const items = (activeFilter === 'all' ? allItems.slice(0, 15) : allItems.filter(item => item.kind === activeFilter).slice(0, 10))
  const [lead, ...rest] = items
  const totalSeconds = Math.max(1, items.reduce((sum, item) => sum + item.seconds, 0))
  const selected = items.find(item => item.key === picked)
  const shareOf = (seconds: number) => Math.max(1, Math.round(seconds / totalSeconds * 100))

  return <section className="listening-section listening-preferences">
    <header>
      <div>
        <h3>聆听偏好</h3>
        <p>{lead ? '按累计聆听时长加权整理' : '听得越多，画像越清晰'}</p>
      </div>
      {availableKinds.length > 1 && <div className="listening-preference-filters" role="group" aria-label="偏好分类筛选">
        <button type="button" aria-pressed={activeFilter === 'all'} onClick={() => setKindFilter('all')}>全部</button>
        {availableKinds.map(kind => <button key={kind} type="button" data-kind={kind} aria-pressed={activeFilter === kind} onClick={() => setKindFilter(kind)}>
          <i aria-hidden="true" />{preferenceKinds[kind]}
        </button>)}
      </div>}
    </header>
    {lead ? <>
      <button type="button" className="listening-preference-spotlight" data-kind={lead.kind} aria-pressed={picked === lead.key}
        aria-label={`最常听的${preferenceKinds[lead.kind]}：${lead.label}，${duration(lead.seconds)}`}
        onClick={() => setPicked(picked === lead.key ? undefined : lead.key)}>
        <div className="spotlight-top">
          <span className="spotlight-eyebrow"><i aria-hidden="true" />最常听的{preferenceKinds[lead.kind]}</span>
          <span className="spotlight-share">TOP 1 · {shareOf(lead.seconds)}%</span>
        </div>
        <div className="spotlight-main">
          <strong>{lead.label}</strong>
          <span>{duration(lead.seconds)}</span>
        </div>
      </button>
      {rest.length > 0 && <div className="listening-preference-constellation">
        {rest.map(item => {
          const ratio = item.seconds / Math.max(1, lead.seconds)
          const tier = ratio >= 0.55 ? 1 : ratio >= 0.25 ? 2 : 3
          return <button key={item.key} type="button" className="preference-capsule" data-kind={item.kind} data-tier={tier}
            aria-label={`${item.label}，${preferenceKinds[item.kind]}，${duration(item.seconds)}`} aria-pressed={item.key === picked}
            onClick={() => setPicked(picked === item.key ? undefined : item.key)}>
            <i aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        })}
      </div>}
      <div className="listening-preference-detail" aria-live="polite">
        {selected ? <>
          <span className="detail-kind-chip" data-kind={selected.kind}>{preferenceKinds[selected.kind]}</span>
          <strong>{selected.label}</strong>
          <span className="detail-metric">{duration(selected.seconds)} · {shareOf(selected.seconds)}%</span>
        </> : <span className="detail-hint">点击任意偏好标签，查看精确聆听时长与占比</span>}
      </div>
    </> : <p className="listening-preference-note">暂无偏好记录</p>}
  </section>
}

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

function StatisticsPeriod({ loading, ready, active, children }: { loading: boolean; ready: boolean; active: boolean; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null)
  useListReveal(content, loading, ready, active)
  return <div ref={content}>{children}</div>
}

export function ListeningStatistics({ onClose }: { onClose: () => void }) {
  const [period, setPeriod] = useState<ListeningPeriod>('week'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const client = useQueryClient()
  const query = useQuery({ queryKey: accountQueryKey('listening-statistics'), queryFn: getListeningStatistics, refetchInterval: 15000 })
  useEffect(() => { window.dispatchEvent(new Event('bilimusic-statistics-sync-requested')) }, [])
  const data = useListDataDuringNavigation(query.data, 'listening-statistics')
  const loading = query.isLoading || Boolean(query.data && !data)
  const top = data?.[period].top
  useEffect(() => { if (top?.length) void hydrateSourceTitles(top.map(track => track.id), client) }, [top, client])
  useEffect(() => {
    if (period !== 'total') return
    let active = true
    const epoch = accountEpoch()
    const hydrate = () => void invoke<number>('listening_hydrate_tags').then(changed => {
      if (active && changed && epoch === accountEpoch()) void client.invalidateQueries({ queryKey: accountQueryKey('listening-statistics') })
    }).catch(() => undefined)
    hydrate()
    const timer = window.setInterval(hydrate, 15000)
    return () => { active = false; window.clearInterval(timer) }
  }, [client, period])
  const today = accountToday(), thisYear = today.getUTCFullYear(), todayKey = dayKey(today)
  const daily = new Map(data?.daily.map(d => [d.day, d.seconds]) || [])
  const enabled = !!data?.sync.enabled
  const uid = data?.sync.uid
  const synchronize = async () => {
    const session = accountEpoch()
    setBusy(true); setError('')
    try {
      const synced = await invoke<boolean>('listening_sync')
      if (session !== accountEpoch()) return
      if (synced) reportSyncError('statistics', false)
      await client.invalidateQueries({ queryKey: accountQueryKey('listening-statistics') })
    } catch (e) {
      if (session !== accountEpoch()) return
      reportSyncError('statistics', true, e)
      setError(syncErrorMessage(e))
    }
    finally { setBusy(false) }
  }
  const configure = async () => {
    if (!uid) return
    setBusy(true); setError('')
    try {
      await invoke('listening_sync_configure', { uid, enabled: !enabled })
      await client.invalidateQueries({ queryKey: accountQueryKey('listening-statistics') })
      window.dispatchEvent(new Event('bilimusic-statistics-sync-requested'))
    } catch (e) { setError(syncErrorMessage(e)) }
    finally { setBusy(false) }
  }
  const syncLabel = enabled ? data?.sync.error ? '账号统计 · 同步待重试' : data?.sync.pending ? '账号统计 · 有待上传记录' : data?.sync.lastSuccess ? '账号统计 · 已同步' : '账号统计 · 等待同步' : data?.sync.paused ? '账号统计同步已暂停' : uid ? '尚未连接统计同步服务' : '未登录 · 仅保存在本机'
  const renderPeriod = (period: ListeningPeriod) => {
    const summary = data?.[period], top = summary?.top
    if (!summary) return <>
      {loading && <ListSkeleton label="正在读取听歌统计"/>}
      {(query.error || error) && <p role="alert" className="inline-error">{error || commandErrorMessage(query.error)}</p>}
    </>
    const summaryTime = listeningTimeParts(summary.seconds)
    const start = new Date(today)
    if (period === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7)
    else start.setUTCDate(1)
    const barCount = period === 'week' ? 7 : new Date(Date.UTC(thisYear, today.getUTCMonth() + 1, 0)).getUTCDate()
    const bars = Array.from({ length: barCount }, (_, i) => {
      const date = new Date(start.getTime() + i * 86400000), key = dayKey(date)
      return { key, label: period === 'week' ? ['一', '二', '三', '四', '五', '六', '日'][i] : String(i + 1), seconds: daily.get(key) || 0, future: key > todayKey }
    })
    const max = Math.max(1, ...bars.map(d => d.seconds)), calendar = period === 'year'
    const chartYear = thisYear
    const activeCalendarDays = data?.daily.filter(d => d.day.startsWith(String(chartYear)) && d.seconds > 0).length || 0
    return <>
      {error && <p role="alert" className="inline-error">{error}</p>}
      <section className="listening-overview" aria-label={`${labels[period]}聆听总览`}>
        <div className="listening-overview-heading"><span className="listening-icon"><Headphones size={18} /></span><span>{labels[period]}聆听时长</span></div>
        <div className="listening-duration"><strong>{summaryTime.value.toLocaleString()}</strong><span>{summaryTime.unit}</span>{summaryTime.minutes !== null && <><strong className="listening-duration-minutes">{summaryTime.minutes}</strong><span>分钟</span></>}</div>
        <div className="listening-metrics">
          <div><strong>{summary.tracks.toLocaleString()}</strong><span><Music2 size={13} />首歌曲</span></div>
          <div><strong>{summary.days.toLocaleString()}</strong><span><CalendarDays size={13} />天聆听</span></div>
          <div title="有效播放次数从新版开始记录"><strong>{summary.plays.toLocaleString()}</strong><span><Headphones size={13} />次播放</span></div>
        </div>
      </section>
      {period === 'total' ? <PreferenceSummary preferences={data?.preferences}/> : <section className="listening-trend listening-section">
        <header><div><h3>{calendar ? '聆听日历' : '聆听足迹'}</h3><p>{calendar ? `${chartYear} 年，${activeCalendarDays} 天有音乐相伴` : period === 'week' ? '这一周，每天听了多久' : `${thisYear} 年 ${today.getUTCMonth() + 1} 月的每日时长`}</p></div><ChartNoAxesColumn size={18} aria-hidden="true" /></header>
        {calendar ? <ListeningCalendar daily={data?.daily || []} year={chartYear} today={todayKey} /> : <>
          <ListeningBars bars={bars} max={max} today={todayKey} weekly={period==='week'}/>
        </>}
      </section>}
      <section className="listening-section listening-favorites"><header><div><h3>常听的声音</h3><p>按聆听时长排序</p></div><span className="listening-count">{top?.length || 0} 首</span></header>
        {top?.length ? <ol className="listening-ranking">{top.map((track, i) => <li key={track.id}>
          <span className="listening-rank" data-leading={i < 3 ? i + 1 : undefined}>{i + 1}</span><ListeningArtwork id={track.id} coverUrl={track.coverUrl} />
          <div className="listening-song"><strong>{track.title}</strong><small>{trackSubtitle({...track, source: {uploaderName: track.uploaderName}})}</small><div className="listening-song-duration"><div className="listening-song-meter" aria-hidden="true"><span style={{ width: `${Math.max(2, track.seconds / Math.max(1, top[0].seconds) * 100)}%` }} /></div><span className="listening-song-time">{duration(track.seconds)}</span></div></div>
        </li>)}</ol> : <div className="listening-empty"><Headphones size={30} /><strong>让喜欢的歌留下足迹</strong><p>开始播放后，这里会记录你常听的声音。</p></div>}
      </section>
      <div className="listening-sync"><span className="listening-sync-icon"><Cloud size={17} /></span><div><strong>{syncLabel}</strong><small>{enabled && data?.sync.lastSuccess ? `上次同步 ${new Date(data.sync.lastSuccess).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : enabled ? `${data?.sync.provider === 'webdav' ? '坚果云' : 'BiliMusic 云'} · 汇总所有设备，约每 15 分钟自动同步` : data?.sync.paused ? '恢复后自动补传本机记录并合并其他设备统计' : '在云同步设置中连接服务，同账号各端使用同一服务和目录'}</small></div>{enabled && <button type="button" disabled={busy} onClick={() => void synchronize()} aria-label="同步听歌统计"><RefreshCw size={15} className={busy ? 'spin' : ''} />{busy ? '同步中' : '同步'}</button>}</div>
      {enabled && data?.sync.error && <p className="inline-error" role="status">{data.sync.error}</p>}
      <details className="listening-explanation"><summary><Info size={13} />统计说明</summary><p>按实际播放时长统计，日期统一采用 UTC+8。同一 B 站账号的各端连接同一同步服务后，共享一份统计；坚果云还需使用同一坚果云账号和目录。汇总所有设备的聆听时长，多端同时播放分别累计。离线记录在联网后补传，未登录时的本机记录不会自动归入账号。有效播放次数从新版开始记录，暂停恢复不重复计次。旧数据计入累计；历史月榜仅包含可还原的明细。</p>{enabled && <p>近 30 天同步估计上传 {bytes(data?.sync.uploadedBytes || 0)}，下载 {bytes(data?.sync.downloadedBytes || 0)}，包含失败尝试，不含网络协议开销。</p>}{uid && (data?.sync.provider || data?.sync.paused) && <button type="button" className="listening-sync-preference" disabled={busy} onClick={() => void configure()}>{enabled ? '暂停账号统计同步' : '恢复账号统计同步'}</button>}</details>
    </>
  }
  const body = <div className="listening-statistics">
    <SwipeTabPages tabs={tabs} value={period} onChange={setPeriod} idPrefix="statistics-period" panelId="statistics-panel"
      label="统计范围" className="listening-period" fill renderPanel={(value, active) =>
        <StatisticsPeriod loading={loading} ready={Boolean(data?.[value])} active={active}>{renderPeriod(value)}</StatisticsPeriod>}/>
  </div>
  return isMobile ? <MobilePage className="listening-statistics-page" title="听歌统计" onBack={onClose} scrollContent={false}>{body}</MobilePage> :
    <CollectionDialog className="listening-statistics-dialog" title="听歌统计" onClose={onClose}>{body}</CollectionDialog>
}
