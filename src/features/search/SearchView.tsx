import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, CircleAlert, LoaderCircle, Play, RefreshCw, SearchX, Waves } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Track } from '../../domain/track'
import { usePlayerStore } from '../player/playerStore'
import { commandErrorMessage, getVideoParts, inDesktopShell, searchBilibili, type BiliSearchItem, type BiliVideoParts } from '../../services/desktopApi'
import { formatDuration } from '../../shared/time'

type ExpandedState = { loading?: boolean; detail?: BiliVideoParts; error?: string }

export function SearchView({ query }: { query: string }) {
  const [expanded, setExpanded] = useState<Record<string, ExpandedState>>({})
  const play = usePlayerStore((state) => state.play)
  const result = useQuery({ queryKey: ['bilibili-search', query], queryFn: () => searchBilibili(query), enabled: Boolean(query) })

  const selectResult = async (item: BiliSearchItem) => {
    const existing = expanded[item.bvid]
    if (existing?.detail) {
      if (existing.detail.parts.length > 1) setExpanded((state) => ({ ...state, [item.bvid]: {} }))
      else if (existing.detail.parts[0]) void play(toTrack(existing.detail, existing.detail.parts[0]))
      return
    }
    setExpanded((state) => ({ ...state, [item.bvid]: { loading: true } }))
    try {
      const detail = await getVideoParts(item.bvid)
      setExpanded((state) => ({ ...state, [item.bvid]: { detail } }))
      if (detail.parts[0]) void play(toTrack(detail, detail.parts[0]))
    } catch (error) {
      setExpanded((state) => ({ ...state, [item.bvid]: { error: commandErrorMessage(error) } }))
    }
  }

  if (!inDesktopShell) return <EmptyState icon={Waves} title="桌面搜索已准备好" detail="请使用 npm run tauri dev 启动原生窗口，浏览器预览不会直接访问平台接口。" />
  if (result.isLoading) return <EmptyState spinning icon={LoaderCircle} title="正在搜索" detail={`正在寻找与“${query}”相关的内容`} />
  if (result.isError) return <EmptyState icon={CircleAlert} title="搜索暂时不可用" detail={commandErrorMessage(result.error)} action={<button onClick={() => result.refetch()}><RefreshCw size={15} />重新尝试</button>} />
  if (!result.data?.items.length) return <EmptyState icon={SearchX} title="没有找到结果" detail="可以尝试歌曲名、歌手名或 BV 号" />

  return <section className="search-results">
    <header><div><span className="eyebrow">SEARCH</span><h2>“{query}”</h2><p>找到约 {result.data.total.toLocaleString()} 个视频，点击条目可解析分 P。</p></div></header>
    <div className="result-list">{result.data.items.map((item) => {
      const state = expanded[item.bvid]
      const open = Boolean(state?.detail && state.detail.parts.length > 1)
      return <article className={open ? 'result-card expanded' : 'result-card'} key={item.bvid}>
        <button className="result-main" onClick={() => selectResult(item)}>
          <span className="result-cover">{item.coverUrl ? <img src={item.coverUrl} alt="" loading="lazy" /> : <Waves />}<i><Play size={17} fill="currentColor" /></i></span>
          <span className="result-copy"><strong>{item.title}</strong><small>{item.uploaderName} · {item.playCount.toLocaleString()} 次播放</small><em>{item.description || '暂无简介'}</em></span>
          <span className="result-duration">{formatDuration(item.durationSeconds)}</span>
          {state?.loading ? <LoaderCircle className="spin" size={19} /> : open ? <ChevronDown size={19} /> : <ChevronRight size={19} />}
        </button>
        {state?.error && <div className="inline-error"><CircleAlert size={14} />{state.error}</div>}
        {open && state?.detail && <div className="parts-list">{state.detail.parts.map((part) => <button key={part.cid} onClick={() => void play(toTrack(state.detail!, part))}><span>P{part.page}</span><strong>{part.title}</strong><small>{formatDuration(part.durationSeconds)}</small><Play size={14} /></button>)}</div>}
      </article>
    })}</div>
  </section>
}

function toTrack(detail: BiliVideoParts, part: BiliVideoParts['parts'][number]): Track {
  return { id: `bilibili:${detail.bvid}:${part.cid}`, source: { provider: 'bilibili', bvid: detail.bvid, aid: detail.aid, cid: part.cid, page: part.page, uploaderId: detail.uploaderId, uploaderName: detail.uploaderName }, title: part.title || detail.title, coverUrl: part.coverUrl || detail.coverUrl, durationSeconds: part.durationSeconds, liked: false }
}

function EmptyState({ icon: Icon, title, detail, spinning, action }: { icon: typeof Waves; title: string; detail: string; spinning?: boolean; action?: ReactNode }) {
  return <div className="search-empty"><span><Icon className={spinning ? 'spin' : ''} /></span><h2>{title}</h2><p>{detail}</p>{action}</div>
}
