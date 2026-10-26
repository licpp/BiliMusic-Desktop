import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, Clock3, Image, LoaderCircle, Maximize2, MessageCircle, Minimize2, RefreshCw, SlidersHorizontal, Video, X } from 'lucide-react'
import { usePlayerStore } from '../player/playerStore'
import {
  commandErrorMessage,
  getDanmaku,
  getVideoSource,
  getStoredLyrics,
  saveStoredLyrics,
  searchLyrics,
  setStoredLyricsBias,
  type LyricCandidate,
  type LyricLine,
  type StoredLyrics,
  type DanmakuItem,
} from '../../services/desktopApi'
import { bestCandidate, candidateLines } from './lrc'
import { CommentsPanel } from '../comments/CommentsPanel'

type Props = { onClose: () => void }

export function LyricsView({ onClose }: Props) {
  const current = usePlayerStore((state) => state.current)
  const progressSeconds = usePlayerStore((state) => state.progressSeconds)
  const playbackStatus = usePlayerStore((state) => state.status)
  const [stored, setStored] = useState<StoredLyrics | null>(null)
  const [lines, setLines] = useState<LyricLine[]>([])
  const [candidates, setCandidates] = useState<LyricCandidate[]>([])
  const [chooserOpen, setChooserOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const lineRefs = useRef<Array<HTMLParagraphElement | null>>([])
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [mediaMode, setMediaMode] = useState<'cover' | 'video'>('cover')
  const [videoUrl, setVideoUrl] = useState('')
  const [videoFullscreen, setVideoFullscreen] = useState(false)
  const [danmaku, setDanmaku] = useState<DanmakuItem[]>([])
  const [danmakuVisible, setDanmakuVisible] = useState(true)
  const [danmakuSize, setDanmakuSize] = useState(() => Number(localStorage.getItem('danmakuSize') || 1))
  const [danmakuOpacity, setDanmakuOpacity] = useState(() => Number(localStorage.getItem('danmakuOpacity') || .8))
  const [commentsOpen, setCommentsOpen] = useState(false)
  const lyricRequest = useRef(0)
  const videoRequest = useRef(0)
  const [lyricQuery, setLyricQuery] = useState(current?.title || '')

  useEffect(() => {
    let cancelled = false
    const request = ++lyricRequest.current
    setStored(null); setLines([]); setCandidates([]); setError('')
    if (!current) return () => { cancelled = true }
    const load = async () => {
      setLoading(true)
      try {
        const existing = await getStoredLyrics(current.id)
        if (cancelled || request !== lyricRequest.current) return
        if (existing) {
          setStored(existing)
          setLines(parseStoredLines(existing))
          return
        }
        const results = await searchLyrics(current.title, current.artist)
        if (cancelled || request !== lyricRequest.current) return
        setCandidates(results)
        const match = bestCandidate(results, current.durationSeconds)
        if (match) await selectCandidate(match, false, request)
        else setError('没有找到合适的歌词，你仍可以重新搜索')
      } catch (cause) {
        if (!cancelled && request === lyricRequest.current) setError(commandErrorMessage(cause))
      } finally {
        if (!cancelled && request === lyricRequest.current) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true; ++lyricRequest.current }
  }, [current?.id])

  useEffect(() => {
    ++videoRequest.current
    setMediaMode('cover'); setVideoUrl(''); setDanmaku([]); setVideoFullscreen(false); setCommentsOpen(false); setChooserOpen(false); setLyricQuery(current?.title || '')
    return () => { ++videoRequest.current }
  }, [current?.id])

  useEffect(() => {
    const element = videoRef.current
    if (!element || !videoUrl) return
    if (Math.abs(element.currentTime - progressSeconds) > .45) element.currentTime = progressSeconds
    if (playbackStatus === 'playing') void element.play().catch(() => undefined)
    else element.pause()
  }, [progressSeconds, playbackStatus, videoUrl])

  const showVideo = async () => {
    if (!current) return
    const request = ++videoRequest.current
    if (mediaMode === 'video') { setMediaMode('cover'); setVideoUrl(''); setDanmaku([]); setVideoFullscreen(false); return }
    setMediaMode('video'); setError('')
    try {
      const source = await getVideoSource(current.source.bvid, current.source.cid)
      if (request !== videoRequest.current) return
      setVideoUrl(source.videoUrl)
      void getDanmaku(current.source.cid).then((comments) => { if (request === videoRequest.current) setDanmaku(comments) }).catch((cause) => { if (request === videoRequest.current) setError(`弹幕加载失败：${commandErrorMessage(cause)}`) })
    } catch (cause) { if (request === videoRequest.current) { setMediaMode('cover'); setError(commandErrorMessage(cause)) } }
  }

  const sortedDanmaku = useMemo(() => [...danmaku].sort((a, b) => a.timeSeconds - b.timeSeconds).map((item, index) => ({ item, index })), [danmaku])
  const activeDanmaku = useMemo(() => {
    let low = 0, high = sortedDanmaku.length
    while (low < high) { const middle = (low + high) >>> 1; if (sortedDanmaku[middle].item.timeSeconds <= progressSeconds) low = middle + 1; else high = middle }
    return sortedDanmaku.slice(Math.max(0, low - 40), low).filter(({ item }) => item.timeSeconds > progressSeconds - 8)
  }, [sortedDanmaku, progressSeconds])

  const activeIndex = useMemo(() => {
    const currentMs = progressSeconds * 1_000 - (stored?.biasMs || 0)
    let result = -1
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].timeMs <= currentMs) result = index
      else break
    }
    return result
  }, [lines, progressSeconds, stored?.biasMs])

  useEffect(() => {
    if (activeIndex >= 0) lineRefs.current[activeIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeIndex])

  async function refreshCandidates(customQuery?: string) {
    if (!current) return
    const request = ++lyricRequest.current
    setChooserOpen(true); setLoading(true); setError('')
    try { const results = await searchLyrics(customQuery || current.title, customQuery ? undefined : current.artist); if (request === lyricRequest.current) setCandidates(results) }
    catch (cause) { if (request === lyricRequest.current) setError(commandErrorMessage(cause)) }
    finally { if (request === lyricRequest.current) setLoading(false) }
  }

  async function selectCandidate(candidate: LyricCandidate, manual: boolean, request = lyricRequest.current) {
    if (!current) return
    const parsed = candidateLines(candidate)
    if (!parsed.length) { setError('这个版本没有可显示的歌词'); return }
    try {
      const saved = await saveStoredLyrics(current.id, candidate, parsed, manual)
      if (request !== lyricRequest.current) return
      setStored(saved); setLines(parsed); setChooserOpen(false); setError('')
    } catch (cause) { if (request === lyricRequest.current) setError(commandErrorMessage(cause)) }
  }

  async function adjustBias(delta: number) {
    if (!current || !stored) return
    try { setStored(await setStoredLyricsBias(current.id, stored.biasMs + delta)) }
    catch (cause) { setError(commandErrorMessage(cause)) }
  }

  if (!current) return <section className="lyrics-view"><button className="lyrics-close" onClick={onClose}><ChevronDown /></button><div className="lyrics-empty"><h2>尚未播放</h2><p>选择歌曲后，这里会显示歌词。</p></div></section>

  return (
    <section className="lyrics-view">
      <header className="lyrics-topbar">
        <button className="lyrics-close" onClick={onClose} aria-label="收起歌词"><ChevronDown /></button>
        <span>正在播放</span>
        <div className="lyrics-actions"><button className="lyrics-rematch" onClick={() => void refreshCandidates()}><RefreshCw size={16} />重新匹配</button><button onClick={() => setCommentsOpen(true)} disabled={!current.source.aid}><MessageCircle size={16} />评论</button></div>
      </header>
      <div className={videoFullscreen ? 'lyrics-album-pane video-fullscreen' : 'lyrics-album-pane'}>
        <div className={mediaMode === 'video' ? 'lyrics-cover video-active' : 'lyrics-cover'}>{mediaMode === 'video' ? <>{videoUrl ? <video ref={videoRef} src={videoUrl} muted playsInline preload="metadata" /> : <div className="video-loading"><LoaderCircle className="spin" />正在加载视频</div>}{danmakuVisible && <div className="danmaku-layer">{activeDanmaku.map(({ item, index }) => <span key={index} style={{ top: `${8 + (index % 9) * 9}%`, color: `#${item.color.toString(16).padStart(6, '0')}`, fontSize: `${Math.max(12, item.fontSize * danmakuSize)}px`, opacity: danmakuOpacity, animationDelay: `${-(progressSeconds - item.timeSeconds)}s`, animationPlayState: playbackStatus === 'playing' ? 'running' : 'paused' }}>{item.text}</span>)}</div>}</> : current.coverUrl ? <img src={current.coverUrl} alt="" /> : <div className="cover-fallback" />}</div>
        <div className="video-tools"><button onClick={() => void showVideo()}>{mediaMode === 'video' ? <Image /> : <Video />}{mediaMode === 'video' ? '显示封面' : '播放视频'}</button>{mediaMode === 'video' && <><button onClick={() => setDanmakuVisible((value) => !value)} className={danmakuVisible ? 'active' : ''}>弹幕</button><label>字号<input type="range" min="0.6" max="1.6" step="0.1" value={danmakuSize} onChange={(event) => { const value = Number(event.target.value); setDanmakuSize(value); localStorage.setItem('danmakuSize', String(value)) }} /></label><label>透明度<input type="range" min="0.2" max="1" step="0.1" value={danmakuOpacity} onChange={(event) => { const value = Number(event.target.value); setDanmakuOpacity(value); localStorage.setItem('danmakuOpacity', String(value)) }} /></label><button onClick={() => setVideoFullscreen((value) => !value)} aria-label="切换视频全屏">{videoFullscreen ? <Minimize2 /> : <Maximize2 />}</button></>}</div>
        <div className="lyrics-track-meta">
          <span className="eyebrow coral">NOW PLAYING</span>
          <h1>{current.title}</h1>
          <p>{current.artist || '歌手未知'}</p>
          {current.album && <small>{current.album}</small>}
          {current.source.uploaderName && <small>UP 主 · {current.source.uploaderName}</small>}
        </div>
      </div>
      <div className="lyrics-scroll" aria-live="polite">
        {loading && !lines.length ? <div className="lyrics-status"><LoaderCircle className="spin" />正在匹配歌词</div> : lines.length ? lines.map((line, index) => (
          <p key={`${line.timeMs}-${index}`} ref={(node) => { lineRefs.current[index] = node }} className={index === activeIndex ? 'active' : index < activeIndex ? 'past' : ''}>{line.text}</p>
        )) : <div className="lyrics-status">{error || '暂无歌词'}</div>}
      </div>
      <aside className="lyrics-bias" aria-label="歌词时间调整">
        <SlidersHorizontal size={16} />
        <button onClick={() => adjustBias(500)} title="歌词延后 0.5 秒">＋</button>
        <span>{stored ? `${stored.biasMs > 0 ? '+' : ''}${(stored.biasMs / 1000).toFixed(1)}s` : '0.0s'}</span>
        <button onClick={() => adjustBias(-500)} title="歌词提前 0.5 秒">−</button>
        <button className="bias-reset" onClick={() => stored && adjustBias(-stored.biasMs)} title="重置偏移"><Clock3 size={14} /></button>
      </aside>
      {error && lines.length > 0 && <div className="lyrics-toast">{error}</div>}
      {chooserOpen && <div className="lyric-chooser-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setChooserOpen(false)}>
        <div className="lyric-chooser">
          <header><div><span className="eyebrow">LYRICS</span><h3>选择歌词版本</h3></div><button onClick={() => setChooserOpen(false)}><X /></button></header>
          <form className="lyric-search-form" onSubmit={(event) => { event.preventDefault(); if (lyricQuery.trim()) void refreshCandidates(lyricQuery.trim()) }}><input aria-label="歌词搜索关键词" value={lyricQuery} onChange={(event) => setLyricQuery(event.target.value)} placeholder="输入歌曲名或歌手重新搜索" /><button disabled={loading || !lyricQuery.trim()}>搜索</button></form>
          {error && <p className="inline-error">{error}</p>}
          {loading ? <div className="chooser-status"><LoaderCircle className="spin" />搜索中</div> : candidates.length ? <div className="candidate-list">{candidates.map((candidate) => (
            <button key={candidate.id} onClick={() => void selectCandidate(candidate, true)}>
              <span><strong>{candidate.trackName}</strong><small>{candidate.artistName || '歌手未知'} · {candidate.albumName || '专辑未知'}</small></span>
              <span>{candidate.syncedLyrics ? '逐行' : '文本'}</span>
              {stored?.providerLyricId === String(candidate.id) ? <Check size={17} /> : <ChevronLeft className="candidate-arrow" size={17} />}
            </button>
          ))}</div> : <div className="chooser-status">没有搜索到可用歌词</div>}
        </div>
      </div>}
      {commentsOpen && current.source.aid && <CommentsPanel key={current.source.aid} aid={current.source.aid} onClose={() => setCommentsOpen(false)} />}
    </section>
  )
}

function parseStoredLines(stored: StoredLyrics): LyricLine[] {
  try {
    const parsed = JSON.parse(stored.parsedJson)
    return Array.isArray(parsed) ? parsed.filter((line) => Number.isFinite(line?.timeMs) && typeof line?.text === 'string') : []
  } catch { return [] }
}
