import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, Clock3, Image, LoaderCircle, Maximize2, MessageCircle, Minimize2, Pencil, RefreshCw, SlidersHorizontal, Video, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { Track } from '../../domain/track'
import { MetadataDialog } from '../library/LibraryView'
import { PlaylistButton } from '../library/TrackActions'
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
import { candidateLines, parseLrc } from './lrc'
import { Artwork } from '../../shared/Artwork'
import { CommentsPanel } from '../comments/CommentsPanel'
import { DanmakuCanvas } from './DanmakuCanvas'
import { SyncedVideo } from './SyncedVideo'

type Props = { onClose: () => void }

export function LyricsView({ onClose }: Props) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<Track | null>(null)
  const current = usePlayerStore((state) => state.current)
  const progressSeconds = usePlayerStore((state) => state.progressSeconds)
  const [stored, setStored] = useState<StoredLyrics | null>(null)
  const [lines, setLines] = useState<LyricLine[]>([])
  const [candidates, setCandidates] = useState<LyricCandidate[]>([])
  const [chooserOpen, setChooserOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualText, setManualText] = useState('')
  const lineRefs = useRef<Array<HTMLParagraphElement | null>>([])
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
  const [lyricArtist, setLyricArtist] = useState(current?.artist || '')
  const [searched, setSearched] = useState(false)

  useEffect(() => {
    let cancelled = false
    const request = ++lyricRequest.current
    setStored(null); setLines([]); setCandidates([]); setError(''); setWarning(''); setManualOpen(false); setManualText(''); setSearched(false)
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
    setMediaMode('cover'); setVideoUrl(''); setDanmaku([]); setVideoFullscreen(false); setCommentsOpen(false); setChooserOpen(false); setEditing(null); setLyricQuery(current?.title || ''); setLyricArtist(current?.artist || '')
    return () => { ++videoRequest.current }
  }, [current?.id])

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

  const syncedLyrics = useMemo(() => Boolean(stored && parseLrc(stored.rawText).length), [stored?.rawText])
  const activeIndex = useMemo(() => {
    if (!syncedLyrics) return -1
    const currentMs = progressSeconds * 1_000 - (stored?.biasMs || 0)
    let result = -1
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].timeMs <= currentMs) result = index
      else break
    }
    return result
  }, [lines, progressSeconds, stored?.biasMs, syncedLyrics])

  useEffect(() => {
    if (activeIndex >= 0) lineRefs.current[activeIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeIndex])

  async function refreshCandidates() {
    if (!current) return
    const request = ++lyricRequest.current
    setLoading(true); setError(''); setWarning(''); setSearched(true)
    try { const results = await searchLyrics(lyricQuery.trim(), lyricArtist.trim() || undefined, true); if (request === lyricRequest.current) { setCandidates(results.candidates); setWarning(results.warning || '') } }
    catch (cause) { if (request === lyricRequest.current) setError(commandErrorMessage(cause)) }
    finally { if (request === lyricRequest.current) setLoading(false) }
  }

  async function importManualLyrics() {
    if (!current || !manualText.trim()) return
    const request = ++lyricRequest.current
    setLoading(false)
    const synced = parseLrc(manualText).length > 0
    await selectCandidate({ provider: 'local', id: 0, trackName: current.title, artistName: current.artist || '', albumName: current.album || '', duration: current.durationSeconds, instrumental: false, syncedLyrics: synced ? manualText.trim() : undefined, plainLyrics: synced ? undefined : manualText.trim() }, true, request)
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
        <div className="lyrics-actions"><PlaylistButton track={current} /><button aria-label="编辑歌曲信息" onClick={() => { setEditing(current); setChooserOpen(false); setCommentsOpen(false) }}><Pencil size={16} />编辑信息</button><button className="lyrics-rematch" onClick={() => setChooserOpen(true)}><RefreshCw size={16} />{stored ? '更换歌词' : '匹配歌词'}</button><button onClick={() => setCommentsOpen(true)} disabled={!current.source.aid}><MessageCircle size={16} />评论</button></div>
      </header>
      <div className={videoFullscreen ? 'lyrics-album-pane video-fullscreen' : 'lyrics-album-pane'}>
        <div className={mediaMode === 'video' ? 'lyrics-cover video-active' : 'lyrics-cover'}>{mediaMode === 'video' ? <>{videoUrl ? <SyncedVideo src={videoUrl} poster={current.coverUrl} /> : <div className="video-startup"><Artwork src={current.coverUrl} /><div className="video-startup-status"><LoaderCircle size={16} className="spin" />正在解析视频线路…</div></div>}{danmakuVisible && videoUrl && <DanmakuCanvas items={danmaku} scale={danmakuSize} opacity={danmakuOpacity} />}</> : <Artwork src={current.coverUrl} />}</div>
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
        {loading && !lines.length ? <div className="lyrics-status"><LoaderCircle className="spin" />正在读取歌词</div> : lines.length ? lines.map((line, index) => (
          <p key={`${line.timeMs}-${index}`} ref={(node) => { lineRefs.current[index] = node }} className={index === activeIndex ? 'active' : index < activeIndex ? 'past' : ''}>{line.text}</p>
        )) : <div className="lyrics-status"><span>{error || '还没有歌词，手动搜索并选择一个版本吧'}</span><button className="load-more" onClick={() => setChooserOpen(true)}>匹配或导入歌词</button></div>}
      </div>
      <aside className="lyrics-bias" aria-label="歌词时间调整">
        <SlidersHorizontal size={16} />
        <button disabled={!syncedLyrics} onClick={() => adjustBias(500)} title="歌词延后 0.5 秒">＋</button>
        <span>{stored ? `${stored.biasMs > 0 ? '+' : ''}${(stored.biasMs / 1000).toFixed(1)}s` : '0.0s'}</span>
        <button disabled={!syncedLyrics} onClick={() => adjustBias(-500)} title="歌词提前 0.5 秒">−</button>
        <button className="bias-reset" onClick={() => stored && adjustBias(-stored.biasMs)} title="重置偏移"><Clock3 size={14} /></button>
      </aside>
      {error && lines.length > 0 && <div className="lyrics-toast">{error}</div>}
      {chooserOpen && <div className="lyric-chooser-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setChooserOpen(false)}>
        <div className="lyric-chooser">
          <header><div><span className="eyebrow">LYRICS</span><h3>选择歌词版本</h3></div><button onClick={() => setChooserOpen(false)}><X /></button></header>
          <form className="lyric-search-form manual-search-fields" onSubmit={(event) => { event.preventDefault(); if (lyricQuery.trim()) void refreshCandidates() }}><label>歌曲名<input aria-label="歌词搜索歌曲名" value={lyricQuery} onChange={(event) => setLyricQuery(event.target.value)} placeholder="填写正确的歌曲名" /></label><label>歌手<input aria-label="歌词搜索歌手" value={lyricArtist} onChange={(event) => setLyricArtist(event.target.value)} placeholder="可选" /></label><button disabled={loading || !lyricQuery.trim()}>搜索歌词</button></form>
          <div className="lyrics-manual-tools"><button onClick={() => setManualOpen((value) => !value)}>{manualOpen ? '收起导入' : '粘贴 LRC / 文本歌词'}</button></div>
          {manualOpen && <form className="lyrics-manual-form" onSubmit={(event) => { event.preventDefault(); void importManualLyrics() }}><textarea aria-label="粘贴歌词内容" maxLength={400000} value={manualText} onChange={(event) => setManualText(event.target.value)} placeholder="粘贴带时间标签的 LRC，或普通文本歌词" /><button disabled={!manualText.trim()}>保存到这首歌</button></form>}
          {error && <p className="inline-error">{error}</p>}
          {warning && <p className="lyrics-warning">{warning}</p>}
          {loading ? <div className="chooser-status"><LoaderCircle className="spin" />搜索中</div> : candidates.length ? <div className="candidate-list">{candidates.map((candidate) => (
            <button key={`${candidate.provider}:${candidate.id}`} onClick={() => void selectCandidate(candidate, true)}>
              <span><strong>{candidate.trackName}</strong><small>{candidate.artistName || '歌手未知'} · {candidate.albumName || '专辑未知'}</small></span>
              <span>{candidate.provider === 'netease' ? '网易云 · ' : ''}{candidate.syncedLyrics ? '逐行' : '文本'}</span>
              {stored?.provider === candidate.provider && stored?.providerLyricId === String(candidate.id) ? <Check size={17} /> : <ChevronLeft className="candidate-arrow" size={17} />}
            </button>
          ))}</div> : !error && <div className="chooser-status">{searched ? '没有搜索到可用歌词，可以更换关键词或粘贴歌词。' : '确认歌曲名和歌手后，点击“搜索歌词”。'}</div>}
        </div>
      </div>}
      {commentsOpen && current.source.aid && <CommentsPanel key={current.source.aid} aid={current.source.aid} onClose={() => setCommentsOpen(false)} />}
      {editing && <MetadataDialog track={editing} onClose={() => setEditing(null)} onSaved={(updated) => { usePlayerStore.getState().updateTrack(updated); setEditing(null); setLyricQuery(updated.title); setLyricArtist(updated.artist || ''); void queryClient.invalidateQueries({ queryKey: ['library'] }); void queryClient.invalidateQueries({ queryKey: ['home-recent'] }) }} />}
    </section>
  )
}

function parseStoredLines(stored: StoredLyrics): LyricLine[] {
  try {
    const parsed = JSON.parse(stored.parsedJson)
    return Array.isArray(parsed) ? parsed.filter((line) => Number.isFinite(line?.timeMs) && typeof line?.text === 'string') : []
  } catch { return [] }
}
