import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, Clock3, LoaderCircle, RefreshCw, SlidersHorizontal, X } from 'lucide-react'
import { usePlayerStore } from '../player/playerStore'
import {
  commandErrorMessage,
  getStoredLyrics,
  saveStoredLyrics,
  searchLyrics,
  setStoredLyricsBias,
  type LyricCandidate,
  type LyricLine,
  type StoredLyrics,
} from '../../services/desktopApi'
import { bestCandidate, candidateLines } from './lrc'

type Props = { onClose: () => void }

export function LyricsView({ onClose }: Props) {
  const current = usePlayerStore((state) => state.current)
  const progressSeconds = usePlayerStore((state) => state.progressSeconds)
  const [stored, setStored] = useState<StoredLyrics | null>(null)
  const [lines, setLines] = useState<LyricLine[]>([])
  const [candidates, setCandidates] = useState<LyricCandidate[]>([])
  const [chooserOpen, setChooserOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const lineRefs = useRef<Array<HTMLParagraphElement | null>>([])

  useEffect(() => {
    let cancelled = false
    setStored(null); setLines([]); setCandidates([]); setError('')
    if (!current) return () => { cancelled = true }
    const load = async () => {
      setLoading(true)
      try {
        const existing = await getStoredLyrics(current.id)
        if (cancelled) return
        if (existing) {
          setStored(existing)
          setLines(parseStoredLines(existing))
          return
        }
        const results = await searchLyrics(current.title, current.artist)
        if (cancelled) return
        setCandidates(results)
        const match = bestCandidate(results, current.durationSeconds)
        if (match) await selectCandidate(match, false, cancelled)
        else setError('没有找到合适的歌词，你仍可以重新搜索')
      } catch (cause) {
        if (!cancelled) setError(commandErrorMessage(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [current?.id])

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

  async function refreshCandidates() {
    if (!current) return
    setChooserOpen(true); setLoading(true); setError('')
    try { setCandidates(await searchLyrics(current.title, current.artist)) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setLoading(false) }
  }

  async function selectCandidate(candidate: LyricCandidate, manual: boolean, cancelled = false) {
    if (!current) return
    const parsed = candidateLines(candidate)
    if (!parsed.length) { setError('这个版本没有可显示的歌词'); return }
    const saved = await saveStoredLyrics(current.id, candidate, parsed, manual)
    if (cancelled) return
    setStored(saved); setLines(parsed); setChooserOpen(false); setError('')
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
        <button className="lyrics-rematch" onClick={refreshCandidates}><RefreshCw size={16} />重新匹配</button>
      </header>
      <div className="lyrics-album-pane">
        <div className="lyrics-cover">{current.coverUrl ? <img src={current.coverUrl} alt="" /> : <div className="cover-fallback" />}</div>
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
          {loading ? <div className="chooser-status"><LoaderCircle className="spin" />搜索中</div> : candidates.length ? <div className="candidate-list">{candidates.map((candidate) => (
            <button key={candidate.id} onClick={() => void selectCandidate(candidate, true)}>
              <span><strong>{candidate.trackName}</strong><small>{candidate.artistName || '歌手未知'} · {candidate.albumName || '专辑未知'}</small></span>
              <span>{candidate.syncedLyrics ? '逐行' : '文本'}</span>
              {stored?.providerLyricId === String(candidate.id) ? <Check size={17} /> : <ChevronLeft className="candidate-arrow" size={17} />}
            </button>
          ))}</div> : <div className="chooser-status">没有搜索到可用歌词</div>}
        </div>
      </div>}
    </section>
  )
}

function parseStoredLines(stored: StoredLyrics): LyricLine[] {
  try {
    const parsed = JSON.parse(stored.parsedJson)
    return Array.isArray(parsed) ? parsed.filter((line) => Number.isFinite(line?.timeMs) && typeof line?.text === 'string') : []
  } catch { return [] }
}
